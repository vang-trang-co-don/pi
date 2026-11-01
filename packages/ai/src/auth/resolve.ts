import type { ProviderEnv } from "../types.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { ModelsError } from "../utils/models-error.ts";

export { ModelsError, type ModelsErrorCode } from "../utils/models-error.ts";

import type {
	AccountEntry,
	AccountPoolCredential,
	ApiKeyAuth,
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Credential,
	CredentialStore,
	OAuthAuth,
	OAuthCredential,
	ProviderAuth,
} from "./types.ts";

export interface AuthResolutionOverrides {
	apiKey?: string;
	env?: ProviderEnv;
	/** Require this much remaining OAuth-token validity; defaults to five minutes. */
	minOAuthValidityMs?: number;
	signal?: AbortSignal;
}

/**
 * Select the active non-cooldown account from a pool.
 * If all accounts are on cooldown and allowCooldown is true, returns the account
 * whose cooldown expires earliest.
 */
export function selectActiveAccount(pool: AccountPoolCredential, allowCooldown = false): AccountEntry | undefined {
	const now = Date.now();
	// 1. Check if designated activeId is valid and not on cooldown
	const active = pool.accounts.find((a) => a.id === pool.activeId && !a.disabled);
	if (active && (!active.cooldownUntil || active.cooldownUntil <= now)) {
		return active;
	}
	// 2. Fallback to first available account not on cooldown
	const standby = pool.accounts.find((a) => !a.disabled && (!a.cooldownUntil || a.cooldownUntil <= now));
	if (standby) return standby;

	// 3. If all are on cooldown and allowCooldown is true, pick the one unlocking earliest
	if (allowCooldown && pool.accounts.length > 0) {
		const nonDisabled = pool.accounts.filter((a) => !a.disabled);
		if (nonDisabled.length > 0) {
			return [...nonDisabled].sort((a, b) => (a.cooldownUntil ?? 0) - (b.cooldownUntil ?? 0))[0];
		}
	}
	return undefined;
}

/**
 * Rotate an account in a provider's AccountPoolCredential after failure (429 rate limit or 401 auth failure).
 * Sets cooldown on the failed account and switches activeId to the next available standby account.
 */
export async function rotateAccountInStore(
	credentials: CredentialStore,
	providerId: string,
	failedAccountId?: string,
	cooldownMs: number = 5 * 60 * 1000,
	signal?: AbortSignal,
): Promise<{ rotated: boolean; activeAccount?: AccountEntry }> {
	let rotated = false;
	let activeAccount: AccountEntry | undefined;

	await credentials.modify(
		providerId,
		async (current) => {
			if (!current || current.type !== "pool") {
				return undefined;
			}
			const now = Date.now();
			const targetId = failedAccountId ?? current.activeId;
			const targetIdx = current.accounts.findIndex((a) => a.id === targetId);

			const updatedAccounts = [...current.accounts];
			if (targetIdx !== -1) {
				const failed = updatedAccounts[targetIdx];
				updatedAccounts[targetIdx] = {
					...failed,
					cooldownUntil: now + cooldownMs,
					errorCount: (failed.errorCount ?? 0) + 1,
				};
			}

			// Find next eligible standby account not on cooldown
			const nextAccount = updatedAccounts.find(
				(a) => a.id !== targetId && !a.disabled && (!a.cooldownUntil || a.cooldownUntil <= now),
			);

			if (nextAccount) {
				rotated = true;
				activeAccount = nextAccount;
				return {
					...current,
					activeId: nextAccount.id,
					accounts: updatedAccounts,
				};
			}

			// All accounts are on cooldown. Still record cooldown on the failed account.
			return {
				...current,
				accounts: updatedAccounts,
			};
		},
		{ signal },
	);

	return { rotated, activeAccount };
}

/**
 * Auth resolution shared by all operations in a `Models` collection.
 * A stored credential owns the provider: ambient/env is consulted only when
 * nothing is stored. No silent env fallback after a failed refresh or for a
 * credential type without a matching handler.
 */
export function resolveProviderAuth(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides?: AuthResolutionOverrides,
): Promise<AuthResult | undefined> {
	const signal = operationSignal(overrides?.signal);
	return raceWithAbortSignal(
		resolveProviderAuthWithSignal(provider, credentials, authContext, overrides, signal),
		signal,
	);
}

async function resolveProviderAuthWithSignal(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides: AuthResolutionOverrides | undefined,
	signal: AbortSignal,
): Promise<AuthResult | undefined> {
	signal.throwIfAborted();
	const requestAuthContext = overrides?.env ? overlayEnvAuthContext(authContext, overrides.env) : authContext;

	if (overrides?.apiKey !== undefined && provider.auth.apiKey) {
		return resolveApiKey(
			requestAuthContext,
			provider.auth.apiKey,
			provider.id,
			{
				type: "api_key",
				key: overrides.apiKey,
				env: overrides.env,
			},
			signal,
		);
	}

	const stored = await readCredential(credentials, provider.id, signal);
	if (stored) {
		if (stored.type === "pool") {
			const activeAccount = selectActiveAccount(stored, true);
			if (!activeAccount) return undefined;
			const accountCred = activeAccount.credential;
			if (accountCred.type === "oauth" && provider.auth.oauth) {
				return resolveStoredOAuth(
					credentials,
					provider.id,
					provider.auth.oauth,
					accountCred,
					signal,
					overrides?.minOAuthValidityMs,
					activeAccount.id,
					activeAccount.label,
				);
			}
			if (accountCred.type === "api_key" && provider.auth.apiKey) {
				const credential = overrides?.env
					? { ...accountCred, env: { ...accountCred.env, ...overrides.env } }
					: accountCred;
				const result = await resolveApiKey(
					requestAuthContext,
					provider.auth.apiKey,
					provider.id,
					credential,
					signal,
				);
				if (result) {
					const sourceLabel = activeAccount.label
						? `${result.source ?? "API Key"} (${activeAccount.label})`
						: result.source;
					return { ...result, source: sourceLabel, accountId: activeAccount.id };
				}
				return undefined;
			}
			return undefined;
		}
		if (stored.type === "oauth" && provider.auth.oauth) {
			return resolveStoredOAuth(
				credentials,
				provider.id,
				provider.auth.oauth,
				stored,
				signal,
				overrides?.minOAuthValidityMs,
			);
		}
		if (stored.type === "api_key" && provider.auth.apiKey) {
			const credential = overrides?.env ? { ...stored, env: { ...stored.env, ...overrides.env } } : stored;
			return resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, credential, signal);
		}
		return undefined;
	}

	// Ambient (env vars, AWS profiles, ADC files).
	return provider.auth.apiKey
		? resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, undefined, signal)
		: undefined;
}

function overlayEnvAuthContext(base: AuthContext, env: ProviderEnv): AuthContext {
	return {
		env: async (name) => env[name] || (await base.env(name)),
		fileExists: (path) => base.fileExists(path),
	};
}

const DEFAULT_OAUTH_MINIMUM_VALIDITY_MS = 5 * 60 * 1000;
const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 15_000;

/**
 * Refresh a stored OAuth credential under the credential-store lock and persist
 * the result before the lock is released. `needsRefresh` is re-checked under
 * the lock, so concurrent callers and processes refresh only once.
 *
 * `signal` cancels only the wait for the lock. Once a refresh starts, the
 * provider may already have rotated the refresh token, so the refresh and its
 * persistence ignore `signal` and are bounded only by a timeout. Otherwise a
 * cancelled caller could discard the only valid refresh token. Callers that
 * must return promptly on cancellation race this promise with their signal.
 *
 * Resolves with the stored OAuth credential after the operation, or undefined
 * when the provider no longer has an OAuth credential.
 */
export async function refreshStoredOAuthCredential(
	credentials: CredentialStore,
	providerId: string,
	oauth: OAuthAuth,
	needsRefresh: (credential: OAuthCredential) => boolean,
	signal: AbortSignal,
	targetAccountId?: string,
): Promise<OAuthCredential | undefined> {
	let post: Credential | undefined;
	let refreshedToken: OAuthCredential | undefined;
	const lockWait = new AbortController();
	const cancelLockWait = () => lockWait.abort(signal.reason);
	signal.addEventListener("abort", cancelLockWait, { once: true });
	if (signal.aborted) cancelLockWait();
	try {
		post = await credentials.modify(
			providerId,
			async (current) => {
				signal.removeEventListener("abort", cancelLockWait);
				signal.throwIfAborted();
				if (!current) return undefined;
				if (current.type === "pool") {
					const targetId = targetAccountId ?? current.activeId;
					const idx = current.accounts.findIndex((a) => a.id === targetId);
					if (idx === -1) return undefined;
					const account = current.accounts[idx];
					if (account.credential.type !== "oauth") return undefined;
					if (!needsRefresh(account.credential)) {
						refreshedToken = account.credential;
						return undefined;
					}
					try {
						const refreshed = await oauth.refresh(
							account.credential,
							AbortSignal.timeout(DEFAULT_OAUTH_REFRESH_TIMEOUT_MS),
						);
						refreshedToken = refreshed;
						const nextAccounts = [...current.accounts];
						nextAccounts[idx] = {
							...account,
							credential: refreshed,
							cooldownUntil: undefined,
						};
						return {
							...current,
							accounts: nextAccounts,
						};
					} catch (error) {
						throw new ModelsError("oauth", `OAuth refresh failed for ${providerId} (account ${targetId})`, {
							cause: error,
						});
					}
				}
				if (current.type !== "oauth") return undefined; // logged out meanwhile
				if (!needsRefresh(current)) {
					refreshedToken = current;
					return undefined; // another process/request refreshed
				}
				try {
					const refreshed = await oauth.refresh(current, AbortSignal.timeout(DEFAULT_OAUTH_REFRESH_TIMEOUT_MS));
					refreshedToken = refreshed;
					return refreshed;
				} catch (error) {
					throw new ModelsError("oauth", `OAuth refresh failed for ${providerId}`, { cause: error });
				}
			},
			{ signal: lockWait.signal },
		);
	} catch (error) {
		if (error instanceof ModelsError) throw error;
		signal.throwIfAborted();
		throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
	} finally {
		signal.removeEventListener("abort", cancelLockWait);
	}
	if (refreshedToken) return refreshedToken;
	if (post?.type === "oauth") return post;
	if (post?.type === "pool") {
		const targetId = targetAccountId ?? post.activeId;
		const acc = post.accounts.find((a) => a.id === targetId);
		return acc?.credential.type === "oauth" ? acc.credential : undefined;
	}
	return undefined;
}

/**
 * OAuth resolution with double-checked locking: tokens with less than five
 * minutes remaining are refreshed through `refreshStoredOAuthCredential`.
 */
async function resolveStoredOAuth(
	credentials: CredentialStore,
	providerId: string,
	oauth: OAuthAuth,
	stored: OAuthCredential,
	signal: AbortSignal,
	minOAuthValidityMs?: number,
	accountId?: string,
	accountLabel?: string,
): Promise<AuthResult | undefined> {
	const minimumValidityMs = Math.max(DEFAULT_OAUTH_MINIMUM_VALIDITY_MS, minOAuthValidityMs ?? 0);
	const expiresSoon = (credential: OAuthCredential) => Date.now() + minimumValidityMs >= credential.expires;
	let credential = stored;

	if (expiresSoon(credential)) {
		// Optimistic check said expired; the authoritative check runs under the lock.
		const post = await refreshStoredOAuthCredential(credentials, providerId, oauth, expiresSoon, signal, accountId);
		if (!post) {
			const current = await readCredential(credentials, providerId, signal);
			if (current?.type === "pool") {
				const acc = current.accounts.find((a) => a.id === (accountId ?? current.activeId));
				if (acc && acc.credential.type === "oauth" && !expiresSoon(acc.credential)) {
					credential = acc.credential;
				} else {
					return undefined;
				}
			} else if (current?.type === "oauth" && !expiresSoon(current)) {
				credential = current;
			} else {
				return undefined;
			}
		} else {
			credential = post;
		}
		// The normal five-minute window triggers a refresh but does not impose a
		// provider contract. Explicit callers (such as bearer-token export) do
		// require the requested minimum after the refresh.
		if (minOAuthValidityMs !== undefined && expiresSoon(credential)) {
			throw new ModelsError("oauth", `OAuth refresh returned a token that expires too soon for ${providerId}`);
		}
	}

	try {
		const source = accountLabel ? `OAuth (${accountLabel})` : "OAuth";
		return { auth: await oauth.toAuth(credential), source, accountId };
	} catch (error) {
		throw new ModelsError("oauth", `OAuth auth derivation failed for ${providerId}`, { cause: error });
	}
}

async function resolveApiKey(
	authContext: AuthContext,
	apiKey: ApiKeyAuth,
	providerId: string,
	credential: ApiKeyCredential | undefined,
	signal: AbortSignal,
): Promise<AuthResult | undefined> {
	try {
		return await apiKey.resolve({ ctx: authContext, credential, signal });
	} catch (error) {
		throw new ModelsError("auth", `API key auth failed for provider ${providerId}`, { cause: error });
	}
}

async function readCredential(
	credentials: CredentialStore,
	providerId: string,
	signal: AbortSignal,
): Promise<Credential | undefined> {
	try {
		return await credentials.read(providerId, { signal });
	} catch (error) {
		throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
	}
}
