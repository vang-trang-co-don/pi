/**
 * Google Cloud Code PA (Antigravity) streaming API implementation.
 *
 * Connects to Google Cloud Code PA endpoints (cloudcode-pa.googleapis.com)
 * supporting Gemini 3, Claude, and GPT-OSS models via Server-Sent Events (SSE).
 */

import type { Content, ThinkingConfig } from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Model,
	ProviderHeaders,
	ProviderStreams,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	Tool,
	ToolCall,
	TranscriptContext,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText } from "../utils/text.ts";
import { collapseSystemMessages, getCurrentTools, getInitialSystemMessage } from "../utils/transcript.ts";
import {
	ANTIGRAVITY_ROUTING,
	type AntigravityModelRouting,
	DEFAULT_ANTIGRAVITY_USER_AGENT,
	getAntigravityUserAgent,
	registerAntigravityRouting,
	resolveRequestModelId,
} from "./google-cloud-code-pa-routing.ts";
import type { GoogleApiThinkingLevel } from "./google-shared.ts";
import {
	convertMessages,
	convertTools,
	isThinkingPart,
	mapStopReasonString,
	mapToolChoice,
	resolveGoogleThinkingLevel,
	retainThoughtSignature,
	supportsGoogleStrictToolSampling,
	toGoogleThinkingLevel,
	usesGoogleThinkingLevel,
} from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

export {
	ANTIGRAVITY_ROUTING,
	type AntigravityModelRouting,
	DEFAULT_ANTIGRAVITY_USER_AGENT,
	getAntigravityUserAgent,
	registerAntigravityRouting,
	resolveRequestModelId,
};

export const CLOUD_CODE_PA_PRIMARY_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const CLOUD_CODE_PA_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const CLOUD_CODE_PA_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";

export const CLOUD_CODE_PA_FALLBACK_ENDPOINTS = [
	CLOUD_CODE_PA_PRIMARY_ENDPOINT,
	CLOUD_CODE_PA_DAILY_ENDPOINT,
	CLOUD_CODE_PA_SANDBOX_ENDPOINT,
] as const;

export const ANTIGRAVITY_SYSTEM_INSTRUCTION =
	"You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding." +
	"You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question." +
	"**Absolute paths only**" +
	"**Proactiveness**";

const CLAUDE_THINKING_BETA_HEADER = "interleaved-thinking-2025-05-14";
const DEFAULT_PROJECT_ID = "aicode-consumers";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_EMPTY_STREAM_RETRIES = 2;
const EMPTY_STREAM_BASE_DELAY_MS = 500;

let toolCallCounter = 0;

export interface GoogleCloudCodePaOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number;
		level?: GoogleApiThinkingLevel;
	};
	projectId?: string;
	sessionId?: string;
}

export interface CloudCodeAssistRequest {
	project: string;
	model: string;
	request: {
		contents: Content[];
		sessionId?: string;
		systemInstruction?: { role?: string; parts: { text: string }[] };
		generationConfig?: {
			maxOutputTokens?: number;
			temperature?: number;
			thinkingConfig?: ThinkingConfig;
		};
		tools?: ReturnType<typeof convertTools>;
		toolConfig?: {
			functionCallingConfig: {
				mode: ReturnType<typeof mapToolChoice>;
			};
		};
	};
	requestType?: string;
	userAgent?: string;
	requestId?: string;
}

export interface CloudCodeAssistResponseChunk {
	response?: {
		candidates?: Array<{
			content?: {
				role: string;
				parts?: Array<{
					text?: string;
					thought?: boolean;
					thoughtSignature?: string;
					functionCall?: {
						name: string;
						args: Record<string, unknown>;
						id?: string;
					};
				}>;
			};
			finishReason?: string;
		}>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			thoughtsTokenCount?: number;
			totalTokenCount?: number;
			cachedContentTokenCount?: number;
		};
		modelVersion?: string;
		responseId?: string;
	};
	traceId?: string;
}

/** Extract retry delay from error headers or body (in milliseconds). */
export function extractRetryDelay(errorText: string, response?: Response | Headers): number | undefined {
	const normalizeDelay = (ms: number): number | undefined => (ms > 0 ? Math.ceil(ms + 1000) : undefined);

	const headers = response instanceof Headers ? response : response?.headers;
	if (headers) {
		const retryAfter = headers.get("retry-after");
		if (retryAfter) {
			const retryAfterSeconds = Number(retryAfter);
			if (Number.isFinite(retryAfterSeconds)) {
				const delay = normalizeDelay(retryAfterSeconds * 1000);
				if (delay !== undefined) return delay;
			}
			const retryAfterDate = new Date(retryAfter);
			const retryAfterMs = retryAfterDate.getTime();
			if (!Number.isNaN(retryAfterMs)) {
				const delay = normalizeDelay(retryAfterMs - Date.now());
				if (delay !== undefined) return delay;
			}
		}

		const rateLimitReset = headers.get("x-ratelimit-reset");
		if (rateLimitReset) {
			const resetSeconds = Number.parseInt(rateLimitReset, 10);
			if (!Number.isNaN(resetSeconds)) {
				const delay = normalizeDelay(resetSeconds * 1000 - Date.now());
				if (delay !== undefined) return delay;
			}
		}

		const rateLimitResetAfter = headers.get("x-ratelimit-reset-after");
		if (rateLimitResetAfter) {
			const resetAfterSeconds = Number(rateLimitResetAfter);
			if (Number.isFinite(resetAfterSeconds)) {
				const delay = normalizeDelay(resetAfterSeconds * 1000);
				if (delay !== undefined) return delay;
			}
		}
	}

	const durationMatch = errorText.match(/reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
	if (durationMatch) {
		const hours = durationMatch[1] ? parseInt(durationMatch[1], 10) : 0;
		const minutes = durationMatch[2] ? parseInt(durationMatch[2], 10) : 0;
		const seconds = parseFloat(durationMatch[3]);
		if (!Number.isNaN(seconds)) {
			const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
			const delay = normalizeDelay(totalMs);
			if (delay !== undefined) return delay;
		}
	}

	const retryInMatch = errorText.match(/Please retry in ([0-9.]+)(ms|s)/i);
	if (retryInMatch?.[1]) {
		const value = parseFloat(retryInMatch[1]);
		if (!Number.isNaN(value) && value > 0) {
			const ms = retryInMatch[2].toLowerCase() === "ms" ? value : value * 1000;
			const delay = normalizeDelay(ms);
			if (delay !== undefined) return delay;
		}
	}

	const retryDelayMatch = errorText.match(/"retryDelay":\s*"([0-9.]+)(ms|s)"/i);
	if (retryDelayMatch?.[1]) {
		const value = parseFloat(retryDelayMatch[1]);
		if (!Number.isNaN(value) && value > 0) {
			const ms = retryDelayMatch[2].toLowerCase() === "ms" ? value : value * 1000;
			const delay = normalizeDelay(ms);
			if (delay !== undefined) return delay;
		}
	}

	return undefined;
}

function isRetryableStatus(status: number, errorText: string): boolean {
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
		return true;
	}
	return /resource.?exhausted|rate.?limit|overloaded|service.?unavailable|other.?side.?closed/i.test(errorText);
}

function extractErrorMessage(errorText: string): string {
	try {
		const parsed = JSON.parse(errorText) as { error?: { message?: string } };
		if (parsed.error?.message) {
			return parsed.error.message;
		}
	} catch {
		// Not JSON
	}
	return errorText;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timeout);
			reject(new Error("Request was aborted"));
		});
	});
}

function isGemini3ProModel(modelId: string): boolean {
	return /gemini-3(?:\.1)?-pro/.test(modelId.toLowerCase());
}

function isGemini3FlashModel(modelId: string): boolean {
	return /gemini-3(?:\.1)?-flash/.test(modelId.toLowerCase());
}

function isGemini3Model(modelId: string): boolean {
	return isGemini3ProModel(modelId) || isGemini3FlashModel(modelId);
}

function getDisabledThinkingConfig(modelId: string): ThinkingConfig {
	if (isGemini3ProModel(modelId)) {
		return { thinkingLevel: "LOW" as unknown as any };
	}
	if (isGemini3FlashModel(modelId)) {
		return { thinkingLevel: "MINIMAL" as unknown as any };
	}
	return { thinkingBudget: 0 };
}

export function buildCloudCodeAssistRequest(
	model: Model<"google-cloud-code-pa">,
	context: TranscriptContext,
	projectId: string,
	options: GoogleCloudCodePaOptions = {},
): CloudCodeAssistRequest {
	const normalizedContext = collapseSystemMessages(context);
	const contents = convertMessages(model, normalizedContext);
	const initialSystemMessage = getInitialSystemMessage(normalizedContext.messages);
	const transcriptTools = getCurrentTools(normalizedContext.messages);
	const messageTools =
		initialSystemMessage?.toolsAdded ?? (initialSystemMessage as { tools?: Tool[] } | undefined)?.tools;
	let currentTools =
		transcriptTools.length > 0
			? transcriptTools
			: messageTools && messageTools.length > 0
				? messageTools
				: ((context as { tools?: Tool[] }).tools ?? []);
	if (currentTools.length === 0) {
		for (const msg of context.messages) {
			const candidate = msg as { tools?: Tool[]; toolsAdded?: Tool[] };
			if (candidate.toolsAdded && candidate.toolsAdded.length > 0) {
				currentTools = candidate.toolsAdded;
				break;
			}
			if (candidate.tools && candidate.tools.length > 0) {
				currentTools = candidate.tools;
				break;
			}
		}
	}

	const generationConfig: CloudCodeAssistRequest["request"]["generationConfig"] = {};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}

	if (options.thinking?.enabled && model.reasoning) {
		generationConfig.thinkingConfig = {
			includeThoughts: true,
		};
		if (options.thinking.level !== undefined) {
			generationConfig.thinkingConfig.thinkingLevel = options.thinking.level as unknown as any;
		} else if (options.thinking.budgetTokens !== undefined) {
			generationConfig.thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
	} else if (model.reasoning && options.thinking && !options.thinking.enabled) {
		generationConfig.thinkingConfig = getDisabledThinkingConfig(model.id);
	}

	const request: CloudCodeAssistRequest["request"] = {
		contents,
	};
	if (options.sessionId) {
		request.sessionId = options.sessionId;
	}

	const isClaude = model.id.startsWith("claude-");
	const supportsStrictMode = supportsGoogleStrictToolSampling(model.id);
	if (currentTools.length > 0) {
		request.tools = convertTools(currentTools, isClaude, supportsStrictMode);
		if (options.toolChoice) {
			request.toolConfig = {
				functionCallingConfig: {
					mode: mapToolChoice(options.toolChoice),
				},
			};
		}
	}

	const userSystemText = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
	const userParts = userSystemText ? [{ text: sanitizeSurrogates(userSystemText) }] : [];

	request.systemInstruction = {
		role: "user",
		parts: [
			{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
			{ text: `Please ignore following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` },
			...userParts,
		],
	};

	if (Object.keys(generationConfig).length > 0) {
		request.generationConfig = generationConfig;
	}

	const runtimeModelId = resolveRequestModelId(model.id, options.thinking?.level);

	return {
		project: projectId,
		model: runtimeModelId,
		request,
		requestType: "agent",
		userAgent: "antigravity",
		requestId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
	};
}

function parseCredentials(
	apiKeyRaw: string | undefined,
	headers?: ProviderHeaders,
): { accessToken: string; projectId: string } {
	let accessToken = "";
	let projectId = "";

	if (apiKeyRaw) {
		try {
			const parsed = JSON.parse(apiKeyRaw) as { token?: string; projectId?: string; access?: string };
			accessToken = parsed.token || parsed.access || "";
			projectId = parsed.projectId || "";
		} catch {
			accessToken = apiKeyRaw.trim();
		}
	}

	if (!accessToken && headers) {
		const authHeader = headers.Authorization || headers.authorization;
		if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
			accessToken = authHeader.slice(7).trim();
		}
	}

	if (!accessToken) {
		throw new Error("Antigravity requires OAuth authentication. Use /login antigravity to authenticate.");
	}

	if (!projectId) {
		projectId = DEFAULT_PROJECT_ID;
	}

	return { accessToken, projectId };
}

export const stream: StreamFunction<"google-cloud-code-pa", GoogleCloudCodePaOptions> = (
	model: Model<"google-cloud-code-pa">,
	context: TranscriptContext,
	options?: GoogleCloudCodePaOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const fetchFn = options?.fetch ?? globalThis.fetch;

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-cloud-code-pa" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const { accessToken, projectId } = parseCredentials(options?.apiKey, options?.headers);
			const effectiveProjectId = options?.projectId || projectId;

			const baseUrl = model.baseUrl?.trim();
			const endpoints =
				!baseUrl || baseUrl === CLOUD_CODE_PA_PRIMARY_ENDPOINT
					? CLOUD_CODE_PA_FALLBACK_ENDPOINTS.map((ep) => `${ep}/v1internal:streamGenerateContent?alt=sse`)
					: [baseUrl];

			let requestBody = buildCloudCodeAssistRequest(model, context, effectiveProjectId, options);
			const nextRequestBody = await options?.onPayload?.(requestBody, model);
			if (nextRequestBody !== undefined) {
				requestBody = nextRequestBody as CloudCodeAssistRequest;
			}

			const isClaude = model.id.startsWith("claude-");
			const requestHeaders: Record<string, string> = {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				"User-Agent": getAntigravityUserAgent(),
				...(isClaude && model.reasoning ? { "anthropic-beta": CLAUDE_THINKING_BETA_HEADER } : {}),
				...providerHeadersToRecord(options?.headers),
			};
			const requestBodyJson = JSON.stringify(requestBody);

			let response: Response | undefined;
			let lastError: Error | undefined;
			let endpointIndex = 0;
			let currentUrl = "";

			for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				try {
					const endpoint = endpoints[endpointIndex];
					currentUrl = endpoint.includes(":streamGenerateContent")
						? endpoint
						: `${endpoint.replace(/\/+$/, "")}/v1internal:streamGenerateContent?alt=sse`;

					response = await fetchFn(currentUrl, {
						method: "POST",
						headers: requestHeaders,
						body: requestBodyJson,
						signal: options?.signal,
					});

					await options?.onResponse?.(
						{ status: response.status, headers: headersToRecord(response.headers) },
						model,
					);

					if (response.ok) {
						break;
					}

					const errorText = await response.text();

					if ((response.status === 403 || response.status === 404) && endpointIndex < endpoints.length - 1) {
						endpointIndex++;
						attempt--;
						continue;
					}

					if (attempt < MAX_RETRIES && isRetryableStatus(response.status, errorText)) {
						if (endpointIndex < endpoints.length - 1) {
							endpointIndex++;
						}

						const serverDelay = extractRetryDelay(errorText, response);
						const delayMs = serverDelay ?? BASE_DELAY_MS * 2 ** attempt;

						const maxDelayMs = options?.maxRetryDelayMs ?? 60000;
						if (maxDelayMs > 0 && serverDelay && serverDelay > maxDelayMs) {
							const delaySeconds = Math.ceil(serverDelay / 1000);
							throw new Error(
								`Server requested ${delaySeconds}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${extractErrorMessage(errorText)}`,
							);
						}

						await sleep(delayMs, options?.signal);
						continue;
					}

					throw new Error(`Cloud Code PA API error (${response.status}): ${extractErrorMessage(errorText)}`);
				} catch (error) {
					if (error instanceof Error) {
						if (error.name === "AbortError" || error.message === "Request was aborted") {
							throw new Error("Request was aborted");
						}
					}
					lastError = error instanceof Error ? error : new Error(String(error));
					if (attempt < MAX_RETRIES) {
						const delayMs = BASE_DELAY_MS * 2 ** attempt;
						await sleep(delayMs, options?.signal);
						continue;
					}
					throw lastError;
				}
			}

			if (!response || !response.ok) {
				throw lastError ?? new Error("Failed to get response after retries");
			}

			let started = false;
			const ensureStarted = () => {
				if (!started) {
					stream.push({ type: "start", partial: output });
					started = true;
				}
			};

			const resetOutput = () => {
				output.content = [];
				output.usage = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				output.stopReason = "stop";
				output.errorMessage = undefined;
				output.timestamp = Date.now();
				started = false;
			};

			const streamResponse = async (activeResponse: Response): Promise<boolean> => {
				if (!activeResponse.body) {
					throw new Error("No response body");
				}

				let hasContent = false;
				let currentBlock: TextContent | ThinkingContent | null = null;
				const blocks = output.content;
				const blockIndex = () => blocks.length - 1;

				const reader = activeResponse.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";

				const abortHandler = () => {
					void reader.cancel().catch(() => {});
				};
				options?.signal?.addEventListener("abort", abortHandler);

				try {
					while (true) {
						if (options?.signal?.aborted) {
							throw new Error("Request was aborted");
						}

						const { done, value } = await reader.read();
						if (done) break;

						buffer += decoder.decode(value, { stream: true });
						const lines = buffer.split("\n");
						buffer = lines.pop() || "";

						for (const line of lines) {
							if (!line.startsWith("data:")) continue;

							const jsonStr = line.slice(5).trim();
							if (!jsonStr) continue;

							let chunk: CloudCodeAssistResponseChunk;
							try {
								chunk = JSON.parse(jsonStr);
							} catch {
								continue;
							}

							const responseData = chunk.response;
							if (!responseData) continue;
							output.responseId ||= responseData.responseId;

							const candidate = responseData.candidates?.[0];
							if (candidate?.content?.parts) {
								for (const part of candidate.content.parts) {
									if (part.text !== undefined) {
										hasContent = true;
										const isThinking = isThinkingPart(part);
										if (
											!currentBlock ||
											(isThinking && currentBlock.type !== "thinking") ||
											(!isThinking && currentBlock.type !== "text")
										) {
											if (currentBlock) {
												if (currentBlock.type === "text") {
													stream.push({
														type: "text_end",
														contentIndex: blockIndex(),
														content: currentBlock.text,
														partial: output,
													});
												} else {
													stream.push({
														type: "thinking_end",
														contentIndex: blockIndex(),
														content: currentBlock.thinking,
														partial: output,
													});
												}
											}
											if (isThinking) {
												currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
												output.content.push(currentBlock);
												ensureStarted();
												stream.push({
													type: "thinking_start",
													contentIndex: blockIndex(),
													partial: output,
												});
											} else {
												currentBlock = { type: "text", text: "" };
												output.content.push(currentBlock);
												ensureStarted();
												stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
											}
										}

										if (currentBlock.type === "thinking") {
											currentBlock.thinking += part.text;
											currentBlock.thinkingSignature = retainThoughtSignature(
												currentBlock.thinkingSignature,
												part.thoughtSignature,
											);
											stream.push({
												type: "thinking_delta",
												contentIndex: blockIndex(),
												delta: part.text,
												partial: output,
											});
										} else {
											currentBlock.text += part.text;
											currentBlock.textSignature = retainThoughtSignature(
												currentBlock.textSignature,
												part.thoughtSignature,
											);
											stream.push({
												type: "text_delta",
												contentIndex: blockIndex(),
												delta: part.text,
												partial: output,
											});
										}
									}

									if (part.functionCall) {
										hasContent = true;
										if (currentBlock) {
											if (currentBlock.type === "text") {
												stream.push({
													type: "text_end",
													contentIndex: blockIndex(),
													content: currentBlock.text,
													partial: output,
												});
											} else {
												stream.push({
													type: "thinking_end",
													contentIndex: blockIndex(),
													content: currentBlock.thinking,
													partial: output,
												});
											}
											currentBlock = null;
										}

										const providedId = part.functionCall.id;
										const needsNewId =
											!providedId ||
											output.content.some((b) => b.type === "toolCall" && b.id === providedId);
										const toolCallId = needsNewId
											? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
											: providedId;

										const toolCall: ToolCall = {
											type: "toolCall",
											id: toolCallId,
											name: part.functionCall.name || "",
											arguments: (part.functionCall.args as Record<string, any>) ?? {},
											...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
										};

										output.content.push(toolCall);
										ensureStarted();
										stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
										stream.push({
											type: "toolcall_delta",
											contentIndex: blockIndex(),
											delta: JSON.stringify(toolCall.arguments),
											partial: output,
										});
										stream.push({
											type: "toolcall_end",
											contentIndex: blockIndex(),
											toolCall,
											partial: output,
										});
									}
								}
							}

							if (candidate?.finishReason) {
								output.stopReason = mapStopReasonString(candidate.finishReason);
								if (output.content.some((b) => b.type === "toolCall")) {
									output.stopReason = "toolUse";
								}
							}

							if (responseData.usageMetadata) {
								const promptTokens = responseData.usageMetadata.promptTokenCount || 0;
								const cacheReadTokens = responseData.usageMetadata.cachedContentTokenCount || 0;
								const outputTokens = responseData.usageMetadata.candidatesTokenCount || 0;
								const inputTokens = Math.max(0, promptTokens - cacheReadTokens);
								output.usage = {
									input: inputTokens,
									output: outputTokens,
									cacheRead: cacheReadTokens,
									cacheWrite: 0,
									totalTokens: promptTokens + outputTokens,
									cost: calculateCost(model, {
										input: inputTokens,
										output: outputTokens,
										cacheRead: cacheReadTokens,
										cacheWrite: 0,
										totalTokens: promptTokens + outputTokens,
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
									}),
								};
							}
						}
					}
				} finally {
					options?.signal?.removeEventListener("abort", abortHandler);
				}

				if (currentBlock) {
					if (currentBlock.type === "text") {
						stream.push({
							type: "text_end",
							contentIndex: blockIndex(),
							content: currentBlock.text,
							partial: output,
						});
					} else {
						stream.push({
							type: "thinking_end",
							contentIndex: blockIndex(),
							content: currentBlock.thinking,
							partial: output,
						});
					}
				}

				return hasContent;
			};

			let receivedContent = false;
			let currentResponse = response;

			for (let emptyAttempt = 0; emptyAttempt <= MAX_EMPTY_STREAM_RETRIES; emptyAttempt++) {
				if (emptyAttempt > 0) {
					const backoffMs = EMPTY_STREAM_BASE_DELAY_MS * 2 ** (emptyAttempt - 1);
					await sleep(backoffMs, options?.signal);

					currentResponse = await fetchFn(currentUrl, {
						method: "POST",
						headers: requestHeaders,
						body: requestBodyJson,
						signal: options?.signal,
					});

					await options?.onResponse?.(
						{ status: currentResponse.status, headers: headersToRecord(currentResponse.headers) },
						model,
					);

					if (!currentResponse.ok) {
						const retryErrorText = await currentResponse.text();
						throw new Error(`Cloud Code PA API error (${currentResponse.status}): ${retryErrorText}`);
					}
				}

				const streamed = await streamResponse(currentResponse);
				if (streamed) {
					receivedContent = true;
					break;
				}

				if (emptyAttempt < MAX_EMPTY_STREAM_RETRIES) {
					resetOutput();
				}
			}

			if (!receivedContent) {
				throw new Error("Cloud Code PA API returned an empty response");
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			const doneReason =
				output.stopReason === "length" || output.stopReason === "toolUse" || output.stopReason === "deferred"
					? output.stopReason
					: "stop";
			stream.push({ type: "done", reason: doneReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"google-cloud-code-pa", SimpleStreamOptions> = (
	model: Model<"google-cloud-code-pa">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies GoogleCloudCodePaOptions;

	if (!options?.reasoning) {
		return stream(model, context, {
			...base,
			thinking: { enabled: false },
		} satisfies GoogleCloudCodePaOptions);
	}

	const clampedReasoning = clampThinkingLevel(model, options.reasoning);
	if (clampedReasoning === "off") {
		return stream(model, context, { ...base, thinking: { enabled: false } } satisfies GoogleCloudCodePaOptions);
	}
	const resolvedLevel = resolveGoogleThinkingLevel(model, clampedReasoning);

	if (usesGoogleThinkingLevel(model) || isGemini3Model(model.id)) {
		return stream(model, context, {
			...base,
			thinking: {
				enabled: true,
				level: toGoogleThinkingLevel(resolvedLevel),
			},
		} satisfies GoogleCloudCodePaOptions);
	}

	const defaultBudgets: ThinkingBudgets = {
		minimal: 1024,
		low: 2048,
		medium: 8192,
		high: 16384,
	};
	const budgets = { ...defaultBudgets, ...options.thinkingBudgets };

	const minOutputTokens = 1024;
	let thinkingBudget = budgets[resolvedLevel] ?? 8192;
	const maxTokens = Math.min((base.maxTokens || 0) + thinkingBudget, model.maxTokens);

	if (maxTokens <= thinkingBudget) {
		thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
	}

	return stream(model, context, {
		...base,
		maxTokens,
		thinking: {
			enabled: true,
			budgetTokens: thinkingBudget,
		},
	} satisfies GoogleCloudCodePaOptions);
};

export const googleCloudCodePaApi = (): ProviderStreams => ({
	stream,
	streamSimple,
});
