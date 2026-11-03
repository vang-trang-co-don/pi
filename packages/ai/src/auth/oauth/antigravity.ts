/**
 * Google Antigravity OAuth flow (Gemini 3, Claude, GPT-OSS via Google Cloud Code PA).
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback server.
 * It is only reachable through lazily loaded OAuth flow modules, never browser entry points.
 */

import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { ModelAuth, OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
import { generatePKCE } from "./pkce.ts";

const decode = (s: string) => atob(s);

export const ANTIGRAVITY_OAUTH_CLIENT_ID =
	getProviderEnvValue("ANTIGRAVITY_CLIENT_ID") ||
	decode("MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==");

export const ANTIGRAVITY_OAUTH_CLIENT_SECRET =
	getProviderEnvValue("ANTIGRAVITY_CLIENT_SECRET") || decode("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");

export const ANTIGRAVITY_SCOPES = [
	"openid",
	"email",
	"profile",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
	"https://www.googleapis.com/auth/aicode",
] as const;

export const ANTIGRAVITY_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const CALLBACK_HOST = getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
export const CALLBACK_PORT = 51121;
export const CALLBACK_PATH = "/oauth-callback";
export const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

export const DEFAULT_PROJECT_ID = "aicode-consumers";
export const DEFAULT_USER_AGENT =
	"antigravity/cli/1.4.12 (aidev_client; os_type=linux; arch=amd64; cl=1010700967; auth_method=consumer)";

export function getAntigravityUserAgent(): string {
	return getProviderEnvValue("PI_AI_ANTIGRAVITY_USER_AGENT") || DEFAULT_USER_AGENT;
}

export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// Not a full URL
	}

	if (value.startsWith("?")) {
		try {
			const url = new URL(`http://localhost${value}`);
			return {
				code: url.searchParams.get("code") ?? undefined,
				state: url.searchParams.get("state") ?? undefined,
			};
		} catch {
			// Ignore
		}
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	return { code: value };
}

export async function getUserEmail(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const response = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
		});

		if (response.ok) {
			const data = (await response.json()) as { email?: string };
			return data.email;
		}
	} catch {
		// Email discovery is optional
	}
	return undefined;
}

interface LoadCodeAssistPayload {
	cloudaicompanionProject?: string | { id?: string };
	currentTier?: { id?: string };
	allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
}

export async function discoverProject(
	accessToken: string,
	signal?: AbortSignal,
	onProgress?: (message: string) => void,
): Promise<string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": getAntigravityUserAgent(),
	};

	const endpoints = [
		"https://cloudcode-pa.googleapis.com",
		"https://daily-cloudcode-pa.googleapis.com",
		"https://daily-cloudcode-pa.sandbox.googleapis.com",
	];

	onProgress?.("Checking for existing Google Cloud Code project...");

	for (const endpoint of endpoints) {
		try {
			const timeoutSignal = signal
				? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
				: AbortSignal.timeout(10_000);
			const loadResponse = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					metadata: {
						ideType: "IDE_UNSPECIFIED",
						platform: "PLATFORM_UNSPECIFIED",
						pluginType: "GEMINI",
					},
				}),
				signal: timeoutSignal,
			});

			if (loadResponse.ok) {
				const data = (await loadResponse.json()) as LoadCodeAssistPayload;

				if (typeof data.cloudaicompanionProject === "string" && data.cloudaicompanionProject.trim()) {
					return data.cloudaicompanionProject.trim();
				}
				if (
					data.cloudaicompanionProject &&
					typeof data.cloudaicompanionProject === "object" &&
					typeof data.cloudaicompanionProject.id === "string" &&
					data.cloudaicompanionProject.id.trim()
				) {
					return data.cloudaicompanionProject.id.trim();
				}
			}
		} catch {
			// Try next endpoint
		}
	}

	onProgress?.(`Using default project (${DEFAULT_PROJECT_ID})...`);
	return DEFAULT_PROJECT_ID;
}

export async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	redirectUri: string,
	signal?: AbortSignal,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
	const response = await fetch(ANTIGRAVITY_TOKEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
			client_secret: ANTIGRAVITY_OAUTH_CLIENT_SECRET,
			code,
			grant_type: "authorization_code",
			redirect_uri: redirectUri,
			code_verifier: verifier,
		}),
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Antigravity token exchange failed (${response.status}): ${errorText}`);
	}

	const data = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};

	if (!data.access_token || !data.refresh_token || typeof data.expires_in !== "number") {
		throw new Error("Antigravity token exchange returned incomplete tokens (missing access or refresh token)");
	}

	return {
		access_token: data.access_token,
		refresh_token: data.refresh_token,
		expires_in: data.expires_in,
	};
}

export async function refreshAntigravityToken(
	refreshToken: string,
	signal?: AbortSignal,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
	const response = await fetch(ANTIGRAVITY_TOKEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
			client_secret: ANTIGRAVITY_OAUTH_CLIENT_SECRET,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Antigravity token refresh failed (${response.status}): ${errorText}`);
	}

	const data = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};

	if (!data.access_token || typeof data.expires_in !== "number") {
		throw new Error("Antigravity token refresh returned invalid tokens");
	}

	return {
		access_token: data.access_token,
		refresh_token: data.refresh_token,
		expires_in: data.expires_in,
	};
}

export async function loginAntigravity(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();

	const startCallback = (port: number) =>
		startOAuthCallbackServer({
			providerName: "Antigravity",
			host: CALLBACK_HOST,
			port,
			path: CALLBACK_PATH,
			redirectHost: "localhost",
			state: verifier,
			complete: async (code) => code,
			signal: interaction.signal,
		});

	// Attempt binding port 51121; fall back to free port or manual input if port is in use
	const callback = await startCallback(CALLBACK_PORT)
		.catch(() => startCallback(0))
		.catch(() => undefined);

	// Google OAuth app strictly requires the registered redirect_uri in the auth URL
	const authRedirectUri = REDIRECT_URI;
	const tokenRedirectUri = callback?.redirectUri ?? REDIRECT_URI;

	try {
		const authParams = new URLSearchParams({
			client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
			response_type: "code",
			redirect_uri: authRedirectUri,
			scope: ANTIGRAVITY_SCOPES.join(" "),
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
			access_type: "offline",
			prompt: "consent",
		});

		const authUrl = `${ANTIGRAVITY_AUTH_URL}?${authParams.toString()}`;
		interaction.notify({
			type: "auth_url",
			url: authUrl,
			instructions:
				"Complete Google sign-in in your browser. If running on a remote/headless machine or loopback callback fails, paste the code or full redirect URL here.",
		});

		const result = await waitForCallbackOrManualInput(interaction, callback, {
			message: "Complete sign-in in your browser, or paste the authorization code / redirect URL here:",
			placeholder: REDIRECT_URI,
		});

		let code: string | undefined;
		if (result.type === "callback") {
			code = result.value;
		} else {
			const parsed = parseAuthorizationInput(result.input);
			if (parsed.state && parsed.state !== verifier) {
				throw new Error("OAuth state mismatch - possible CSRF attack");
			}
			code = parsed.code;
		}

		if (!code) {
			throw new Error("Missing authorization code");
		}

		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		const tokenData = await exchangeAuthorizationCode(
			code,
			verifier,
			// If browser redirected to callback server, use its redirectUri; otherwise use registered authRedirectUri
			result.type === "callback" ? tokenRedirectUri : authRedirectUri,
			interaction.signal,
		);

		interaction.notify({ type: "progress", message: "Discovering Google Cloud Code project..." });
		const [email, projectId] = await Promise.all([
			getUserEmail(tokenData.access_token, interaction.signal),
			discoverProject(tokenData.access_token, interaction.signal, (message) => {
				interaction.notify({ type: "progress", message });
			}),
		]);

		return {
			type: "oauth",
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
			projectId: projectId || DEFAULT_PROJECT_ID,
			email,
		};
	} finally {
		callback?.close();
	}
}

export const antigravityOAuth: OAuthAuth = {
	name: "Antigravity",
	isSubscription: true,
	loginLabel: "Sign in with Google Antigravity",

	async login(interaction) {
		return loginAntigravity(interaction);
	},

	async refresh(credential, signal) {
		const refreshed = await refreshAntigravityToken(credential.refresh, signal);
		const existingProjectId = typeof credential.projectId === "string" ? credential.projectId : undefined;
		const projectId =
			existingProjectId || (await discoverProject(refreshed.access_token, signal)) || DEFAULT_PROJECT_ID;

		const email =
			typeof credential.email === "string" && credential.email
				? credential.email
				: await getUserEmail(refreshed.access_token, signal);

		return {
			...credential,
			type: "oauth",
			access: refreshed.access_token,
			refresh: refreshed.refresh_token || credential.refresh,
			expires: Date.now() + refreshed.expires_in * 1000 - 5 * 60 * 1000,
			projectId,
			...(email ? { email } : {}),
		};
	},

	async toAuth(credential: OAuthCredential): Promise<ModelAuth> {
		const projectId = (typeof credential.projectId === "string" && credential.projectId) || DEFAULT_PROJECT_ID;
		return {
			apiKey: JSON.stringify({
				token: credential.access,
				projectId,
			}),
			headers: {
				Authorization: `Bearer ${credential.access}`,
				"User-Agent": getAntigravityUserAgent(),
			},
		};
	},
};
