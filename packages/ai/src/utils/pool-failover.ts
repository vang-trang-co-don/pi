import type { AssistantMessageEvent } from "../types.ts";

export interface FailoverRotator {
	rotateAccount(
		providerId: string,
		failedAccountId?: string,
		cooldownMs?: number,
		options?: { signal?: AbortSignal },
	): Promise<{ rotated: boolean }>;
}

export function isPoolFailoverError(error: unknown): { isFailover: boolean; reason: "rate_limit" | "auth_failure" } {
	if (!error) return { isFailover: false, reason: "rate_limit" };
	const msg = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
	const status =
		typeof error === "object" && error !== null && "status" in error
			? (error as { status: unknown }).status
			: undefined;

	if (
		status === 429 ||
		/(?:429|rate.?limit|too many requests|resource_exhausted|quota|exceeded your current quota|insufficient_quota|freeusagelimit|subscription_sharing_usage_limit_exceeded)/i.test(
			msg,
		)
	) {
		return { isFailover: true, reason: "rate_limit" };
	}
	if (
		status === 401 ||
		/(?:401|unauthenticated|invalid authentication credentials|invalid_grant|unauthorized)/i.test(msg)
	) {
		return { isFailover: true, reason: "auth_failure" };
	}
	return { isFailover: false, reason: "rate_limit" };
}

export async function* streamWithPoolFailover(
	providerId: string,
	rotator: FailoverRotator,
	createStream: () => Promise<AsyncIterable<AssistantMessageEvent>>,
	signal?: AbortSignal,
	maxAttempts = 3,
): AsyncIterable<AssistantMessageEvent> {
	let attempt = 0;
	while (attempt < maxAttempts) {
		attempt++;
		let stream: AsyncIterable<AssistantMessageEvent>;
		try {
			stream = await createStream();
		} catch (error) {
			const { isFailover, reason } = isPoolFailoverError(error);
			if (isFailover && attempt < maxAttempts) {
				const cooldownMs = reason === "rate_limit" ? 5 * 60 * 1000 : 15 * 60 * 1000;
				const { rotated } = await rotator.rotateAccount(providerId, undefined, cooldownMs, { signal });
				if (rotated) {
					continue;
				}
			}
			throw error;
		}

		let emittedContent = false;
		let shouldRotateAndRetry = false;
		let failoverReason: "rate_limit" | "auth_failure" = "rate_limit";

		try {
			for await (const event of stream) {
				if (event.type === "error" && !emittedContent) {
					const { isFailover, reason } = isPoolFailoverError(event.error?.errorMessage);
					if (isFailover && attempt < maxAttempts) {
						shouldRotateAndRetry = true;
						failoverReason = reason;
						break;
					}
				}
				if (
					event.type === "text_delta" ||
					event.type === "toolcall_start" ||
					event.type === "toolcall_delta" ||
					event.type === "done"
				) {
					emittedContent = true;
				}
				yield event;
			}
		} catch (error) {
			if (!emittedContent) {
				const { isFailover, reason } = isPoolFailoverError(error);
				if (isFailover && attempt < maxAttempts) {
					shouldRotateAndRetry = true;
					failoverReason = reason;
				} else {
					throw error;
				}
			} else {
				throw error;
			}
		}

		if (shouldRotateAndRetry) {
			const cooldownMs = failoverReason === "rate_limit" ? 5 * 60 * 1000 : 15 * 60 * 1000;
			const { rotated } = await rotator.rotateAccount(providerId, undefined, cooldownMs, { signal });
			if (rotated) {
				continue;
			}
		}

		return;
	}
}
