import { describe, expect, it, vi } from "vitest";
import { builtinProviders } from "../src/providers/all.ts";
import { ANTIGRAVITY_MODELS } from "../src/providers/antigravity.models.ts";
import {
	antigravityProvider,
	fetchAntigravityRemoteModels,
	parseAvailableModelsPayload,
} from "../src/providers/antigravity.ts";

describe("Antigravity Provider & Models", () => {
	it("initializes antigravityProvider with baseline models and OAuth auth", () => {
		const provider = antigravityProvider();
		expect(provider.id).toBe("antigravity");
		expect(provider.name).toBe("Antigravity");
		expect(provider.auth.oauth).toBeDefined();
		expect(provider.auth.oauth?.name).toBe("Antigravity");
		expect(provider.auth.oauth?.isSubscription).toBe(true);

		const models = provider.getModels();
		expect(models.length).toBeGreaterThanOrEqual(Object.keys(ANTIGRAVITY_MODELS).length);

		// Key baseline models must be present
		const modelIds = models.map((m) => m.id);
		expect(modelIds).toContain("gemini-3.8-flash");
		expect(modelIds).toContain("gemini-2.5-flash");
		expect(modelIds).toContain("gemini-3.5-flash-lite");
		expect(modelIds).toContain("claude-sonnet-4-6");
		expect(modelIds).toContain("claude-opus-4-6");
		expect(modelIds).toContain("gpt-oss-120b");

		for (const model of models) {
			expect(model.api).toBe("google-cloud-code-pa");
			expect(model.provider).toBe("antigravity");
		}
	});

	it("is registered in builtinProviders()", () => {
		const all = builtinProviders();
		const antigravity = all.find((p) => p.id === "antigravity");
		expect(antigravity).toBeDefined();
		expect(antigravity?.name).toBe("Antigravity");
	});

	it("parses dynamic fetchAvailableModels payload correctly", () => {
		const mockPayload = {
			models: {
				"gemini-3.8-flash-high": {
					displayName: "Gemini 3.8 Flash (High)",
					supportsImages: true,
					supportsThinking: true,
					maxTokens: 1048576,
					maxOutputTokens: 65536,
				},
				"claude-opus-4-6-thinking": {
					displayName: "Claude Opus 4.6 (Thinking)",
					supportsImages: true,
					supportsThinking: true,
					maxTokens: 200000,
					maxOutputTokens: 64000,
				},
				MODEL_INTERNAL_PLACEHOLDER: {
					displayName: "Internal Only",
				},
				chat_internal_test: {
					displayName: "Internal Chat",
				},
			},
		};

		const parsed = parseAvailableModelsPayload("antigravity", "https://cloudcode-pa.googleapis.com", mockPayload);
		expect(parsed).toHaveLength(2);

		const gemini = parsed.find((m) => m.id === "gemini-3.8-flash");
		expect(gemini).toBeDefined();
		expect(gemini?.name).toBe("Gemini 3.8 Flash");
		expect(gemini?.input).toEqual(["text", "image"]);
		expect(gemini?.reasoning).toBe(true);
		expect(gemini?.thinkingLevelMap?.high).toBe("high");
		expect(gemini?.thinkingLevelMap?.off).toBeNull();
		expect(gemini?.thinkingLevelMap?.minimal).toBeNull();
		expect(gemini?.contextWindow).toBe(1048576);
		expect(gemini?.maxTokens).toBe(65536);

		const claude = parsed.find((m) => m.id === "claude-opus-4-6");
		expect(claude).toBeDefined();
		expect(claude?.name).toBe("Claude Opus 4.6 (Thinking)");
		expect(claude?.reasoning).toBe(true);
		expect(claude?.thinkingLevelMap?.high).toBe("high");
		expect(claude?.thinkingLevelMap?.off).toBeNull();

		// Filtered internal models
		expect(parsed.some((m) => m.id === "MODEL_INTERNAL_PLACEHOLDER")).toBe(false);
		expect(parsed.some((m) => m.id === "chat_internal_test")).toBe(false);
	});

	it("fetches remote models using OAuth credentials", async () => {
		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			expect(String(input)).toContain("/v1internal:fetchAvailableModels");
			return new Response(
				JSON.stringify({
					models: {
						"gemini-future-4-preview": {
							displayName: "Gemini Future 4 Preview",
							supportsImages: true,
							supportsThinking: true,
							maxTokens: 2000000,
							maxOutputTokens: 100000,
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const fetched = await fetchAntigravityRemoteModels("antigravity", "https://cloudcode-pa.googleapis.com", {
			credential: {
				type: "oauth",
				access: "mock-access-token",
				refresh: "mock-refresh",
				expires: Date.now() + 3600000,
				projectId: "test-proj",
			},
			signal: new AbortController().signal,
			allowNetwork: true,
			force: false,
			publish: async () => true,
		});

		expect(fetched).toHaveLength(1);
		expect(fetched[0].id).toBe("gemini-future-4-preview");
		expect(fetched[0].name).toBe("Gemini Future 4 Preview");
		expect(fetched[0].maxTokens).toBe(100000);
	});
});
