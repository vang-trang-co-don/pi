import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ANTIGRAVITY_AUTH_URL,
	ANTIGRAVITY_OAUTH_CLIENT_ID,
	ANTIGRAVITY_SCOPES,
	ANTIGRAVITY_TOKEN_URL,
	antigravityOAuth,
	DEFAULT_PROJECT_ID,
	discoverProject,
	exchangeAuthorizationCode,
	getAntigravityUserAgent,
	parseAuthorizationInput,
	REDIRECT_URI,
	refreshAntigravityToken,
} from "../src/auth/oauth/antigravity.ts";
import type { AuthEvent } from "../src/auth/types.ts";

const neverAbortedSignal = new AbortController().signal;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function getFormBody(init?: RequestInit): URLSearchParams {
	if (typeof init?.body === "string") {
		return new URLSearchParams(init.body);
	}
	if (init?.body instanceof URLSearchParams) {
		return init.body;
	}
	throw new Error(`Expected form body, got ${typeof init?.body}`);
}

describe.sequential("Antigravity OAuth Flow", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("parses authorization input correctly from different formats", () => {
		// Full URL
		const fromUrl = parseAuthorizationInput("http://localhost:51121/oauth-callback?code=abc1234&state=xyz789");
		expect(fromUrl.code).toBe("abc1234");
		expect(fromUrl.state).toBe("xyz789");

		// Query string
		const fromQs = parseAuthorizationInput("?code=def567&state=state1");
		expect(fromQs.code).toBe("def567");
		expect(fromQs.state).toBe("state1");

		// Form query params
		const fromParams = parseAuthorizationInput("code=ghi890&state=state2");
		expect(fromParams.code).toBe("ghi890");
		expect(fromParams.state).toBe("state2");

		// Hash separated
		const fromHash = parseAuthorizationInput("code123#state123");
		expect(fromHash.code).toBe("code123");
		expect(fromHash.state).toBe("state123");

		// Raw code
		const fromRaw = parseAuthorizationInput("plain-code");
		expect(fromRaw.code).toBe("plain-code");
		expect(fromRaw.state).toBeUndefined();

		// Empty
		const fromEmpty = parseAuthorizationInput("");
		expect(fromEmpty.code).toBeUndefined();
	});

	it("discovers project ID correctly via loadCodeAssist", async () => {
		// String project format
		const fetchMockString = vi.fn(async (input: unknown): Promise<Response> => {
			expect(getUrl(input)).toContain("/v1internal:loadCodeAssist");
			return jsonResponse({
				cloudaicompanionProject: "discovered-project-123",
				currentTier: { id: "free-tier" },
			});
		});
		vi.stubGlobal("fetch", fetchMockString);

		const projectId = await discoverProject("mock-token", neverAbortedSignal);
		expect(projectId).toBe("discovered-project-123");
		expect(fetchMockString).toHaveBeenCalled();

		// Object project format
		const fetchMockObj = vi.fn(async (): Promise<Response> => {
			return jsonResponse({
				cloudaicompanionProject: { id: "nested-project-456" },
			});
		});
		vi.stubGlobal("fetch", fetchMockObj);

		const projectId2 = await discoverProject("mock-token", neverAbortedSignal);
		expect(projectId2).toBe("nested-project-456");

		// Fallback when loadCodeAssist fails
		const fetchMockFail = vi.fn(async (): Promise<Response> => {
			return new Response("Not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMockFail);

		const projectIdFallback = await discoverProject("mock-token", neverAbortedSignal);
		expect(projectIdFallback).toBe(DEFAULT_PROJECT_ID);
	});

	it("exchanges authorization code with PKCE verifier", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe(ANTIGRAVITY_TOKEN_URL);
			expect(init?.method).toBe("POST");
			const form = getFormBody(init);
			expect(form.get("grant_type")).toBe("authorization_code");
			expect(form.get("client_id")).toBe(ANTIGRAVITY_OAUTH_CLIENT_ID);
			expect(form.get("code")).toBe("auth-code-123");
			expect(form.get("code_verifier")).toBe("pkce-verifier-123");
			expect(form.get("redirect_uri")).toBe(REDIRECT_URI);

			return jsonResponse({
				access_token: "mock-access-token",
				refresh_token: "mock-refresh-token",
				expires_in: 3600,
				token_type: "Bearer",
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const tokens = await exchangeAuthorizationCode(
			"auth-code-123",
			"pkce-verifier-123",
			REDIRECT_URI,
			neverAbortedSignal,
		);
		expect(tokens.access_token).toBe("mock-access-token");
		expect(tokens.refresh_token).toBe("mock-refresh-token");
		expect(tokens.expires_in).toBe(3600);
	});

	it("refreshes Antigravity token via refresh_token", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe(ANTIGRAVITY_TOKEN_URL);
			expect(init?.method).toBe("POST");
			const form = getFormBody(init);
			expect(form.get("grant_type")).toBe("refresh_token");
			expect(form.get("client_id")).toBe(ANTIGRAVITY_OAUTH_CLIENT_ID);
			expect(form.get("refresh_token")).toBe("existing-refresh-token");

			return jsonResponse({
				access_token: "new-access-token",
				expires_in: 3600,
				token_type: "Bearer",
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const refreshed = await refreshAntigravityToken("existing-refresh-token", neverAbortedSignal);
		expect(refreshed.access_token).toBe("new-access-token");
		expect(refreshed.expires_in).toBe(3600);
	});

	it("completes full login flow via manual input fallback", async () => {
		let capturedAuthUrl = "";
		const notifications: AuthEvent[] = [];

		const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);

			if (url === ANTIGRAVITY_TOKEN_URL) {
				return jsonResponse({
					access_token: "new-access-token-xyz",
					refresh_token: "new-refresh-token-xyz",
					expires_in: 3600,
				});
			}

			if (url.includes("oauth2/v1/userinfo")) {
				return jsonResponse({
					email: "developer@example.com",
				});
			}

			if (url.includes("/v1internal:loadCodeAssist")) {
				return jsonResponse({
					cloudaicompanionProject: "user-project-999",
				});
			}

			return new Response("Not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const credential = await antigravityOAuth.login({
			signal: neverAbortedSignal,
			notify: (event) => {
				notifications.push(event);
				if (event.type === "auth_url") {
					capturedAuthUrl = event.url;
				}
			},
			prompt: async (prompt) => {
				if (prompt.type === "manual_code") {
					const parsed = new URL(capturedAuthUrl);
					const state = parsed.searchParams.get("state")!;
					return `http://localhost:51121/oauth-callback?code=manual-code-winner&state=${state}`;
				}
				throw new Error(`Unexpected prompt: ${prompt.type}`);
			},
		});

		expect(capturedAuthUrl).toContain(ANTIGRAVITY_AUTH_URL);
		expect(capturedAuthUrl).toContain(`client_id=${ANTIGRAVITY_OAUTH_CLIENT_ID}`);
		expect(capturedAuthUrl).toContain("response_type=code");
		for (const scope of ANTIGRAVITY_SCOPES) {
			expect(capturedAuthUrl).toContain(encodeURIComponent(scope));
		}

		expect(credential.type).toBe("oauth");
		expect(credential.access).toBe("new-access-token-xyz");
		expect(credential.refresh).toBe("new-refresh-token-xyz");
		expect(credential.projectId).toBe("user-project-999");
		expect(credential.email).toBe("developer@example.com");
		expect(credential.expires).toBeGreaterThan(Date.now());
	});

	it("converts credential to request auth via toAuth", async () => {
		const auth = await antigravityOAuth.toAuth({
			type: "oauth",
			access: "ya29.sample_token_123",
			refresh: "refresh_123",
			expires: Date.now() + 3600000,
			projectId: "my-cloud-project",
		});

		expect(auth.apiKey).toBe(
			JSON.stringify({
				token: "ya29.sample_token_123",
				projectId: "my-cloud-project",
			}),
		);
		expect(auth.headers?.Authorization).toBe("Bearer ya29.sample_token_123");
		expect(auth.headers?.["User-Agent"]).toBe(getAntigravityUserAgent());
	});

	it("rejects login when state mismatch occurs (CSRF protection)", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			antigravityOAuth.login({
				signal: neverAbortedSignal,
				notify: () => {},
				prompt: async (prompt) => {
					if (prompt.type === "manual_code") {
						return "http://localhost:51121/oauth-callback?code=forged-code&state=forged-state";
					}
					throw new Error(`Unexpected prompt: ${prompt.type}`);
				},
			}),
		).rejects.toThrow("OAuth state mismatch");
	});
});
