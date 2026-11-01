import { describe, expect, it, vi } from "vitest";
import {
	ANTIGRAVITY_SYSTEM_INSTRUCTION,
	buildCloudCodeAssistRequest,
	DEFAULT_ANTIGRAVITY_USER_AGENT,
	extractRetryDelay,
	googleCloudCodePaApi,
	stream,
	streamSimple,
} from "../src/api/google-cloud-code-pa.ts";
import type { AssistantMessageEvent, Model, Tool, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function createSseStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
}

function sseResponse(dataLines: unknown[]): Response {
	const body = dataLines.map((obj) => `data: ${JSON.stringify(obj)}\n\n`);
	return new Response(createSseStream(body), {
		status: 200,
		headers: {
			"Content-Type": "text/event-stream",
		},
	});
}

const mockGeminiModel: Model<"google-cloud-code-pa"> = {
	id: "gemini-3.8-flash-high",
	name: "Gemini 3.8 Flash (High)",
	api: "google-cloud-code-pa",
	provider: "antigravity",
	baseUrl: "https://cloudcode-pa.googleapis.com",
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: true,
	contextWindow: 1048576,
	maxTokens: 65536,
};

const mockClaudeModel: Model<"google-cloud-code-pa"> = {
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	api: "google-cloud-code-pa",
	provider: "antigravity",
	baseUrl: "https://cloudcode-pa.googleapis.com",
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: true,
	contextWindow: 200000,
	maxTokens: 64000,
};

describe("Google Cloud Code PA Streaming API", () => {
	it("correctly extracts retry delay from headers and body patterns", () => {
		// Retry-After header in seconds
		const headers1 = new Headers({ "retry-after": "15" });
		expect(extractRetryDelay("Rate limit exceeded", headers1)).toBe(16000);

		// x-ratelimit-reset-after
		const headers2 = new Headers({ "x-ratelimit-reset-after": "20" });
		expect(extractRetryDelay("Rate limit exceeded", headers2)).toBe(21000);

		// Body regex: reset after 39s
		expect(extractRetryDelay("Your quota will reset after 39s")).toBe(40000);

		// Body regex: reset after 2m10s
		expect(extractRetryDelay("Quota exceeded: reset after 2m10s")).toBe(131000);

		// Body regex: Please retry in 5s
		expect(extractRetryDelay("Please retry in 5s")).toBe(6000);

		// JSON field retryDelay
		expect(extractRetryDelay('{"error": {"details": [{"retryDelay": "12.5s"}]}}')).toBe(13500);
	});

	it("builds Cloud Code PA request envelope with required Antigravity system instruction", () => {
		const context: TranscriptContext = normalizeContext({
			messages: [
				{
					role: "user",
					content: "Hello from user",
					timestamp: Date.now(),
				},
			],
		});

		const request = buildCloudCodeAssistRequest(mockGeminiModel, context, "test-project-123", {
			thinking: { enabled: true, level: "HIGH" },
		});

		expect(request.project).toBe("test-project-123");
		expect(request.model).toBe("gemini-3.8-flash-high");
		expect(request.requestType).toBe("agent");
		expect(request.userAgent).toBe("antigravity");
		expect(request.requestId).toMatch(/^agent-\d+-[a-z0-9]+$/);

		// System instruction wrapping
		expect(request.request.systemInstruction?.role).toBe("user");
		const systemParts = request.request.systemInstruction?.parts ?? [];
		expect(systemParts[0]?.text).toBe(ANTIGRAVITY_SYSTEM_INSTRUCTION);
		expect(systemParts[1]?.text).toContain(`[ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]`);

		// Contents
		expect(request.request.contents).toHaveLength(1);
		expect(request.request.contents?.[0]?.parts?.[0]).toEqual({ text: "Hello from user" });

		// Generation config thinking
		expect(request.request.generationConfig?.thinkingConfig?.includeThoughts).toBe(true);
		expect(request.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("HIGH");
	});

	it("uses legacy parameters schema and sets interleaved-thinking beta header for Claude models", async () => {
		const testTool: Tool = {
			name: "read_file",
			description: "Read a file from disk",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "File path" },
				},
				required: ["path"],
			},
		};

		const context: TranscriptContext = normalizeContext({
			messages: [
				{
					role: "system",
					content: "Base system prompt",
					toolsAdded: [testTool],
					timestamp: Date.now(),
				},
				{
					role: "user",
					content: "Read foo.txt",
					timestamp: Date.now(),
				},
			],
		});

		const request = buildCloudCodeAssistRequest(mockClaudeModel, context, "claude-project");
		// Claude models use parameters, not parametersJsonSchema
		const declarations = request.request.tools?.[0].functionDeclarations as Array<{
			name: string;
			parameters?: unknown;
			parametersJsonSchema?: unknown;
		}>;
		expect(declarations[0].name).toBe("read_file");
		expect(declarations[0].parameters).toBeDefined();
		expect(declarations[0].parametersJsonSchema).toBeUndefined();

		// Check header injection during stream()
		let capturedHeaders: Record<string, string> = {};
		const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit): Promise<Response> => {
			capturedHeaders = init?.headers as Record<string, string>;
			return sseResponse([
				{
					response: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [{ text: "Done reading" }],
								},
								finishReason: "STOP",
							},
						],
						usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
					},
				},
			]);
		});

		const eventStream = stream(mockClaudeModel, context, {
			apiKey: JSON.stringify({ token: "claude-access-token", projectId: "claude-project" }),
			fetch: fetchMock,
		});

		const message = await eventStream.result();
		expect(message.content).toEqual([{ type: "text", text: "Done reading" }]);
		expect(capturedHeaders["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14");
		expect(capturedHeaders["User-Agent"]).toBe(DEFAULT_ANTIGRAVITY_USER_AGENT);
		expect(capturedHeaders.Authorization).toBe("Bearer claude-access-token");
	});

	it("streams SSE events into AssistantMessageEventStream with thinking blocks and tool calls", async () => {
		const context: TranscriptContext = normalizeContext({
			messages: [
				{
					role: "user",
					content: "Compute 2 + 2",
					timestamp: Date.now(),
				},
			],
		});

		const fetchMock = vi.fn(async (): Promise<Response> => {
			return sseResponse([
				// Thinking chunk
				{
					response: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [{ thought: true, text: "I need to calculate 2 + 2." }],
								},
							},
						],
						responseId: "resp-12345",
					},
				},
				// Text chunk
				{
					response: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [{ text: "The answer is 4." }],
								},
							},
						],
					},
				},
				// Tool call chunk
				{
					response: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [
										{
											functionCall: {
												name: "calculator",
												args: { expression: "2 + 2" },
												id: "calc-call-1",
											},
										},
									],
								},
								finishReason: "STOP",
							},
						],
						usageMetadata: {
							promptTokenCount: 15,
							cachedContentTokenCount: 5,
							candidatesTokenCount: 20,
						},
					},
				},
			]);
		});

		const events: AssistantMessageEvent[] = [];
		const eventStream = stream(mockGeminiModel, context, {
			apiKey: JSON.stringify({ token: "gemini-access-token", projectId: "gemini-project" }),
			fetch: fetchMock,
		});

		for await (const event of eventStream) {
			events.push(event);
		}

		const message = await eventStream.result();

		// Check events emitted
		const eventTypes = events.map((e) => e.type);
		expect(eventTypes).toContain("start");
		expect(eventTypes).toContain("thinking_start");
		expect(eventTypes).toContain("thinking_delta");
		expect(eventTypes).toContain("thinking_end");
		expect(eventTypes).toContain("text_start");
		expect(eventTypes).toContain("text_delta");
		expect(eventTypes).toContain("text_end");
		expect(eventTypes).toContain("toolcall_start");
		expect(eventTypes).toContain("toolcall_delta");
		expect(eventTypes).toContain("toolcall_end");
		expect(eventTypes).toContain("done");

		// Check message content
		expect(message.content).toHaveLength(3);
		expect(message.content[0]).toEqual({
			type: "thinking",
			thinking: "I need to calculate 2 + 2.",
			thinkingSignature: undefined,
		});
		expect(message.content[1]).toEqual({
			type: "text",
			text: "The answer is 4.",
		});
		expect(message.content[2]).toEqual({
			type: "toolCall",
			id: "calc-call-1",
			name: "calculator",
			arguments: { expression: "2 + 2" },
		});

		// Tool use overrides finish reason
		expect(message.stopReason).toBe("toolUse");

		// Check token counts (input = prompt - cacheRead)
		expect(message.usage.input).toBe(10);
		expect(message.usage.cacheRead).toBe(5);
		expect(message.usage.output).toBe(20);
		expect(message.responseId).toBe("resp-12345");
	});

	it("cascades across endpoints on 403 or 404", async () => {
		const context: TranscriptContext = normalizeContext({
			messages: [{ role: "user", content: "Ping", timestamp: Date.now() }],
		});

		const requestedUrls: string[] = [];
		const fetchMock = vi.fn(async (url: unknown): Promise<Response> => {
			const urlStr = String(url);
			requestedUrls.push(urlStr);

			// First endpoint 404s
			if (urlStr.startsWith("https://cloudcode-pa.googleapis.com")) {
				return new Response("Not found", { status: 404 });
			}

			// Fallback endpoint succeeds
			return sseResponse([
				{
					response: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [{ text: "Fallback endpoint succeeded" }],
								},
								finishReason: "STOP",
							},
						],
					},
				},
			]);
		});

		const eventStream = stream(mockGeminiModel, context, {
			apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
			fetch: fetchMock,
		});

		const message = await eventStream.result();
		expect(message.content[0]).toEqual({ type: "text", text: "Fallback endpoint succeeded" });
		expect(requestedUrls).toHaveLength(2);
		expect(requestedUrls[0]).toContain("https://cloudcode-pa.googleapis.com");
		expect(requestedUrls[1]).toContain("https://daily-cloudcode-pa.googleapis.com");
	});

	it("streamSimple configures thinking level based on reasoning option", async () => {
		const context: TranscriptContext = normalizeContext({
			messages: [{ role: "user", content: "Test simple", timestamp: Date.now() }],
		});

		let capturedPayload: unknown;
		const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit): Promise<Response> => {
			capturedPayload = JSON.parse(init?.body as string);
			return sseResponse([
				{
					response: {
						candidates: [{ content: { role: "model", parts: [{ text: "Simple response" }] } }],
					},
				},
			]);
		});

		const eventStream = streamSimple(mockGeminiModel, context, {
			apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
			reasoning: "low",
			fetch: fetchMock,
		});

		await eventStream.result();
		const payload = capturedPayload as {
			request: { generationConfig: { thinkingConfig: { thinkingLevel: string } } };
		};
		expect(payload.request.generationConfig.thinkingConfig.thinkingLevel).toBe("LOW");
	});

	it("googleCloudCodePaApi factory satisfies ProviderStreams contract", () => {
		const api = googleCloudCodePaApi();
		expect(typeof api.stream).toBe("function");
		expect(typeof api.streamSimple).toBe("function");
	});
});
