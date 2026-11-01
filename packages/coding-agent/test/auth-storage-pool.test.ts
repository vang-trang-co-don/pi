import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";

describe("AuthStorage pool operations", () => {
	it("adds first account creating a single-item pool", async () => {
		const storage = AuthStorage.inMemory({});
		await storage.addAccount("openai", {
			id: "acc-1",
			label: "Work Key",
			credential: { type: "api_key", key: "sk-work" },
		});

		const accounts = await storage.getAccounts("openai");
		expect(accounts.length).toBe(1);
		expect(accounts[0].id).toBe("acc-1");
		expect(accounts[0].label).toBe("Work Key");

		const activeId = await storage.getActiveAccountId("openai");
		expect(activeId).toBe("acc-1");
	});

	it("converts existing single credential to pool when adding second account", async () => {
		const storage = AuthStorage.inMemory({
			openai: { type: "api_key", key: "sk-old" },
		});

		await storage.addAccount(
			"openai",
			{
				id: "acc-new",
				label: "New Key",
				credential: { type: "api_key", key: "sk-new" },
			},
			true,
		);

		const accounts = await storage.getAccounts("openai");
		expect(accounts.length).toBe(2);
		expect(accounts[0].id).toBe("account-1");
		expect(accounts[1].id).toBe("acc-new");

		const activeId = await storage.getActiveAccountId("openai");
		expect(activeId).toBe("acc-new");
	});

	it("switches active account", async () => {
		const storage = AuthStorage.inMemory({
			antigravity: {
				type: "pool",
				activeId: "acc-1",
				accounts: [
					{
						id: "acc-1",
						label: "Email 1",
						credential: { type: "oauth", access: "a1", refresh: "r1", expires: 0 },
					},
					{
						id: "acc-2",
						label: "Email 2",
						credential: { type: "oauth", access: "a2", refresh: "r2", expires: 0 },
					},
				],
			},
		});

		const success = await storage.setActiveAccount("antigravity", "acc-2");
		expect(success).toBe(true);

		const activeId = await storage.getActiveAccountId("antigravity");
		expect(activeId).toBe("acc-2");
	});

	it("removes account and updates activeId", async () => {
		const storage = AuthStorage.inMemory({
			antigravity: {
				type: "pool",
				activeId: "acc-1",
				accounts: [
					{
						id: "acc-1",
						label: "Email 1",
						credential: { type: "oauth", access: "a1", refresh: "r1", expires: 0 },
					},
					{
						id: "acc-2",
						label: "Email 2",
						credential: { type: "oauth", access: "a2", refresh: "r2", expires: 0 },
					},
				],
			},
		});

		await storage.removeAccount("antigravity", "acc-1");

		const accounts = await storage.getAccounts("antigravity");
		expect(accounts.length).toBe(1);
		expect(accounts[0].id).toBe("acc-2");

		const activeId = await storage.getActiveAccountId("antigravity");
		expect(activeId).toBe("acc-2");
	});
});
