import { getProviderEnvValue } from "../utils/provider-env.ts";

export const DEFAULT_ANTIGRAVITY_USER_AGENT =
	"antigravity/cli/1.4.12 (aidev_client; os_type=linux; arch=amd64; cl=1010700967; auth_method=consumer)";

export function getAntigravityUserAgent(): string {
	return getProviderEnvValue("PI_AI_ANTIGRAVITY_USER_AGENT") || DEFAULT_ANTIGRAVITY_USER_AGENT;
}

export interface AntigravityModelRouting {
	off?: string;
	routing?: Record<string, string>;
	defaultRequestId?: string;
}

/** Mapping of public model names to backend routing when reasoning effort is selected. */
export const ANTIGRAVITY_ROUTING: Record<string, AntigravityModelRouting> = {
	"claude-opus-4-6": {
		routing: {
			low: "claude-opus-4-6-thinking",
			medium: "claude-opus-4-6-thinking",
			high: "claude-opus-4-6-thinking",
		},
		defaultRequestId: "claude-opus-4-6-thinking",
	},
	"claude-sonnet-4-6": {
		off: "claude-sonnet-4-6",
		routing: {
			low: "claude-sonnet-4-6",
			medium: "claude-sonnet-4-6",
			high: "claude-sonnet-4-6",
		},
		defaultRequestId: "claude-sonnet-4-6",
	},
	"gemini-3.1-pro": {
		routing: {
			low: "gemini-3.1-pro-low",
			medium: "gemini-3.1-pro-low",
			high: "gemini-pro-agent",
		},
		defaultRequestId: "gemini-3.1-pro-low",
	},
	"gemini-3.8-flash": {
		routing: {
			low: "gemini-3.8-flash-low",
			medium: "gemini-3.8-flash-medium",
			high: "gemini-3.8-flash-high",
		},
		defaultRequestId: "gemini-3.8-flash-medium",
	},
	"gemini-3.7-flash": {
		routing: {
			low: "gemini-3.7-flash-low",
			medium: "gemini-3.7-flash-medium",
			high: "gemini-3.7-flash-high",
		},
		defaultRequestId: "gemini-3.7-flash-medium",
	},
	"gemini-3.5-flash": {
		routing: {
			low: "gemini-3.5-flash-low",
			medium: "gemini-3.5-flash-low",
			high: "gemini-3-flash-agent",
		},
		defaultRequestId: "gemini-3.5-flash-low",
	},
	"gpt-oss-120b": {
		routing: {
			low: "gpt-oss-120b-medium",
			medium: "gpt-oss-120b-medium",
			high: "gpt-oss-120b-medium",
		},
		defaultRequestId: "gpt-oss-120b-medium",
	},
};

export function registerAntigravityRouting(modelId: string, routing: AntigravityModelRouting): void {
	ANTIGRAVITY_ROUTING[modelId] = routing;
}

export function resolveRequestModelId(modelId: string, level?: string): string {
	const routing = ANTIGRAVITY_ROUTING[modelId];
	if (!routing) return modelId;
	if (level) {
		const effortKey = level.toLowerCase();
		if (routing.routing?.[effortKey]) {
			return routing.routing[effortKey];
		}
	}
	return routing.defaultRequestId || modelId;
}
