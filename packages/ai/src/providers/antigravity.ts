import { googleCloudCodePaApi } from "../api/google-cloud-code-pa.lazy.ts";
import { getAntigravityUserAgent, registerAntigravityRouting } from "../api/google-cloud-code-pa-routing.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadAntigravityOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { Model } from "../types.ts";
import { ANTIGRAVITY_MODELS } from "./antigravity-models.ts";

export interface AntigravityProviderOptions {
	id?: string;
	name?: string;
	baseUrl?: string;
}

interface RawAvailableModelInfo {
	displayName?: string;
	name?: string;
	supportsImages?: boolean;
	supportsThinking?: boolean;
	maxTokens?: number;
	maxOutputTokens?: number;
	thinkingBudget?: number;
	minThinkingBudget?: number;
	recommended?: boolean;
}

interface ModelGroup {
	publicId: string;
	displayName?: string;
	supportsImages: boolean;
	supportsThinking: boolean;
	contextWindow: number;
	maxTokens: number;
	variants: {
		low?: string;
		medium?: string;
		high?: string;
	};
}

const THINKING_SUFFIXES: Array<{ suffix: string; level: "low" | "medium" | "high" }> = [
	{ suffix: "-extra-low", level: "low" },
	{ suffix: "-low", level: "low" },
	{ suffix: "-medium", level: "medium" },
	{ suffix: "-high", level: "high" },
	{ suffix: "-thinking", level: "high" },
];

function cleanDisplayName(name: string | undefined, id: string): string {
	if (!name) return id;
	return name.replace(/\s*\((Low|Medium|High|Thinking)\)/i, "").trim() || id;
}

const KNOWN_DEAD_MODELS = new Set(["gemini-3.5-flash", "gemini-3.7-flash", "gemini-3.1-pro", "gemini-2.5-pro"]);

export function parseAvailableModelsPayload(
	providerId: string,
	baseUrl: string,
	data: unknown,
): Model<"google-cloud-code-pa">[] {
	if (!data || typeof data !== "object") return [];
	const modelsRecord = (data as { models?: Record<string, RawAvailableModelInfo> }).models;
	if (!modelsRecord || typeof modelsRecord !== "object") return [];

	const groups = new Map<string, ModelGroup>();

	for (const [modelId, info] of Object.entries(modelsRecord)) {
		if (!info || typeof info !== "object") continue;
		if (
			modelId.startsWith("MODEL_") ||
			modelId.startsWith("chat_") ||
			modelId.startsWith("tab_") ||
			modelId.endsWith("-disabled") ||
			KNOWN_DEAD_MODELS.has(modelId)
		) {
			continue;
		}

		let publicId = modelId;
		let detectedLevel: "low" | "medium" | "high" | undefined;

		// Retain -tiered as its own standalone model
		if (!modelId.endsWith("-tiered")) {
			for (const { suffix, level } of THINKING_SUFFIXES) {
				if (modelId.endsWith(suffix)) {
					publicId = modelId.slice(0, -suffix.length);
					detectedLevel = level;
					break;
				}
			}
		}

		if (KNOWN_DEAD_MODELS.has(publicId) || publicId.endsWith("-disabled")) {
			continue;
		}

		let group = groups.get(publicId);
		if (!group) {
			const baseline = ANTIGRAVITY_MODELS[publicId];
			group = {
				publicId,
				displayName: baseline?.name ?? cleanDisplayName(info.displayName || info.name, publicId),
				supportsImages: Boolean(info.supportsImages),
				supportsThinking: Boolean(info.supportsThinking),
				contextWindow: typeof info.maxTokens === "number" ? info.maxTokens : 1048576,
				maxTokens: typeof info.maxOutputTokens === "number" ? info.maxOutputTokens : 65536,
				variants: {},
			};
			groups.set(publicId, group);
		} else {
			if (info.supportsImages) group.supportsImages = true;
			if (info.supportsThinking) group.supportsThinking = true;
			if (typeof info.maxTokens === "number" && info.maxTokens > group.contextWindow) {
				group.contextWindow = info.maxTokens;
			}
			if (typeof info.maxOutputTokens === "number" && info.maxOutputTokens > group.maxTokens) {
				group.maxTokens = info.maxOutputTokens;
			}
		}

		if (detectedLevel) {
			group.variants[detectedLevel] = modelId;
		}
	}

	const models: Model<"google-cloud-code-pa">[] = [];

	for (const [publicId, group] of groups.entries()) {
		const hasVariants = Object.keys(group.variants).length > 0;
		const supportsThinking = group.supportsThinking || hasVariants;
		const hasOff = publicId === "claude-sonnet-4-6";

		if (hasVariants) {
			registerAntigravityRouting(publicId, {
				off: hasOff ? publicId : undefined,
				routing: {
					low: group.variants.low ?? group.variants.medium ?? publicId,
					medium: group.variants.medium ?? group.variants.low ?? publicId,
					high: group.variants.high ?? group.variants.medium ?? publicId,
				},
				defaultRequestId: group.variants.medium ?? group.variants.low ?? publicId,
			});
		}

		models.push({
			id: publicId,
			name: group.displayName || publicId,
			api: "google-cloud-code-pa",
			provider: providerId,
			baseUrl,
			input: group.supportsImages ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			reasoning: supportsThinking,
			...(supportsThinking
				? {
						thinkingLevelMap: {
							off: hasOff ? "off" : null,
							minimal: null,
							low: "low",
							medium: "medium",
							high: "high",
							xhigh: null,
							max: null,
						},
					}
				: {}),
			contextWindow: group.contextWindow,
			maxTokens: group.maxTokens,
		});
	}

	return models;
}

export async function fetchAntigravityRemoteModels(
	providerId: string,
	baseUrl: string,
	context: RefreshModelsContext,
): Promise<readonly Model<"google-cloud-code-pa">[]> {
	const credential = context.credential;
	if (!credential) return [];

	let token = "";
	let projectId = "aicode-consumers";

	if (credential.type === "oauth") {
		token = credential.access;
		if (typeof credential.projectId === "string" && credential.projectId) {
			projectId = credential.projectId;
		}
	} else if (credential.type === "api_key" && credential.key) {
		try {
			const parsed = JSON.parse(credential.key) as { token?: string; projectId?: string };
			token = parsed.token || credential.key;
			if (parsed.projectId) projectId = parsed.projectId;
		} catch {
			token = credential.key;
		}
	}

	if (!token) return [];

	const endpoints = [baseUrl, "https://daily-cloudcode-pa.googleapis.com"];

	for (const endpoint of endpoints) {
		try {
			const response = await fetch(`${endpoint.replace(/\/+$/, "")}/v1internal:fetchAvailableModels`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					"User-Agent": getAntigravityUserAgent(),
				},
				body: JSON.stringify({ project: projectId }),
				signal: AbortSignal.any([context.signal, AbortSignal.timeout(10_000)]),
			});

			if (response.ok) {
				const data = await response.json();
				const parsed = parseAvailableModelsPayload(providerId, baseUrl, data);
				if (parsed.length > 0) {
					return parsed;
				}
			}
		} catch {
			// Try fallback endpoint
		}
	}

	return [];
}

/**
 * Antigravity provider factory with baseline models and dynamic catalog discovery.
 */
export function antigravityProvider(options: AntigravityProviderOptions = {}): Provider<"google-cloud-code-pa"> {
	const id = options.id ?? "antigravity";
	const name = options.name ?? "Antigravity";
	const baseUrl = options.baseUrl ?? "https://cloudcode-pa.googleapis.com";

	return createProvider<"google-cloud-code-pa">({
		id,
		name,
		baseUrl,
		auth: {
			oauth: lazyOAuth({
				name,
				isSubscription: true,
				loginLabel: "Sign in with Google Antigravity",
				load: loadAntigravityOAuth,
			}),
		},
		models: Object.values(ANTIGRAVITY_MODELS).map((model) => ({
			...model,
			provider: id,
			baseUrl,
		})),
		fetchModels: async (context) => fetchAntigravityRemoteModels(id, baseUrl, context),
		api: googleCloudCodePaApi(),
	});
}
