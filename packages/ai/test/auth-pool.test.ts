import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { rotateAccountInStore, selectActiveAccount } from "../src/auth/resolve.ts";
import type { AccountPoolCredential } from "../src/auth/types.ts";
import { isPoolFailoverError, streamWithPoolFailover } from "../src/utils/pool-failover.ts";

describe("selectActiveAccount", () => {
	it("returns active account when not on cooldown", () => {
		const pool: AccountPoolCredential = {
			type: "pool",
			activeId: "acc-1",
			accounts: [
				{ id: "acc-1", label: "Account 1", credential: { type: "api_key", key: "key-1" } },
				{ id: "acc-2", label: "Account 2", credential: { type: "api_key", key: "key-2" } },
			],
		};
		const selected = selectActiveAccount(pool);
		expect(selected?.id).toBe("acc-1");
	});

	it("falls back to standby account when active account is on cooldown", () => {
		const pool: AccountPoolCredential = {
			type: "pool",
			activeId: "acc-1",
			accounts: [
				{
					id: "acc-1",
					label: "Account 1",
					credential: { type: "api_key", key: "key-1" },
					cooldownUntil: Date.now() + 60_000,
				},
				{ id: "acc-2", label: "Account 2", credential: { type: "api_key", key: "key-2" } },
			],
		};
		const selected = selectActiveAccount(pool);
		expect(selected?.id).toBe("acc-2");
	});

	it("picks shortest cooldown when all are on cooldown and allowCooldown is true", () => {
		const pool: AccountPoolCredential = {
			type: "pool",
			activeId: "acc-1",
			accounts: [
				{
					id: "acc-1",
					label: "Account 1",
					credential: { type: "api_key", key: "key-1" },
					cooldownUntil: Date.now() + 120_000,
				},
				{
					id: "acc-2",
					label: "Account 2",
					credential: { type: "api_key", key: "key-2" },
					cooldownUntil: Date.now() + 30_000,
				},
			],
		};
		const selected = selectActiveAccount(pool, true);
		expect(selected?.id).toBe("acc-2");
	});
});

describe("rotateAccountInStore", () => {
	it("switches activeId and sets cooldown on failed account", async () => {
		const store = new InMemoryCredentialStore();
		const pool: AccountPoolCredential = {
			type: "pool",
			activeId: "acc-1",
			accounts: [
				{ id: "acc-1", label: "Account 1", credential: { type: "api_key", key: "key-1" } },
				{ id: "acc-2", label: "Account 2", credential: { type: "api_key", key: "key-2" } },
			],
		};
		await store.modify("openai", async () => pool);

		const result = await rotateAccountInStore(store, "openai", "acc-1", 60_000);
		expect(result.rotated).toBe(true);
		expect(result.activeAccount?.id).toBe("acc-2");

		const updated = (await store.read("openai")) as AccountPoolCredential;
		expect(updated.activeId).toBe("acc-2");
		expect(updated.accounts[0].cooldownUntil).toBeGreaterThan(Date.now());
		expect(updated.accounts[0].errorCount).toBe(1);
	});
});

describe("isPoolFailoverError", () => {
	it("detects 429 rate limit errors", () => {
		expect(isPoolFailoverError({ status: 429 }).isFailover).toBe(true);
		expect(isPoolFailoverError(new Error("Resource has been exhausted (code 429)")).isFailover).toBe(true);
		expect(isPoolFailoverError(new Error("insufficient_quota")).isFailover).toBe(true);
	});

	it("detects 401 auth errors", () => {
		expect(isPoolFailoverError({ status: 401 }).isFailover).toBe(true);
		expect(
			isPoolFailoverError(new Error("UNAUTHENTICATED (code 401): Request had invalid authentication credentials"))
				.isFailover,
		).toBe(true);
	});
});

describe("streamWithPoolFailover", () => {
	it("replays on failover error when rotator succeeds", async () => {
		let attempts = 0;
		const fakeRotator = {
			rotateAccount: async () => {
				return { rotated: true };
			},
		};

		async function* streamProducer() {
			attempts++;
			if (attempts === 1) {
				throw new Error("HTTP 429 Resource exhausted");
			}
			yield { type: "text_delta" as const, delta: "Success after failover!" };
			yield { type: "done" as const, message: {} as any };
		}

		const events: any[] = [];
		for await (const event of streamWithPoolFailover("openai", fakeRotator, async () => streamProducer() as any)) {
			events.push(event);
		}

		expect(attempts).toBe(2);
		expect(events.length).toBe(2);
		expect(events[0].delta).toBe("Success after failover!");
	});
});
