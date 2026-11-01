import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { stream } from "../src/api/google-cloud-code-pa.ts";
import { discoverProject } from "../src/auth/oauth/antigravity.ts";
import { antigravityProvider } from "../src/providers/antigravity.ts";
import type { Model, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function getActiveKeyringCredentials(): { access_token: string; email?: string } | undefined {
	try {
		const pythonScript = `
import gi, json
from gi.repository import Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
_, sp = bus.call_sync("org.freedesktop.secrets", "/org/freedesktop/secrets", "org.freedesktop.Secret.Service", "OpenSession", GLib.Variant("(sv)", ("plain", GLib.Variant("s", ""))), GLib.VariantType("(vo)"), Gio.DBusCallFlags.NONE, -1, None).unpack()
data = json.loads(bytes(bus.call_sync("org.freedesktop.secrets", "/org/freedesktop/secrets/collection/login/3", "org.freedesktop.Secret.Item", "GetSecret", GLib.Variant("(o)", (sp,)), GLib.VariantType("((oayays))"), Gio.DBusCallFlags.NONE, -1, None).unpack()[0][2]).decode("utf-8"))
print(json.dumps({"access_token": data["token"]["access_token"], "email": data.get("id_token_email")}))
`;
		const output = execSync("python3", { input: pythonScript, encoding: "utf-8", timeout: 5000 });
		return JSON.parse(output.trim());
	} catch {
		return undefined;
	}
}

const activeCreds = getActiveKeyringCredentials();

describe("Antigravity Live End-to-End Verification", () => {
	it.skipIf(!activeCreds?.access_token)("discovers project live via loadCodeAssist", async () => {
		const projectId = await discoverProject(activeCreds!.access_token);
		expect(projectId).toBe("aicode-consumers");
	});

	it.skipIf(!activeCreds?.access_token)("refreshes dynamic models from fetchAvailableModels", async () => {
		const provider = antigravityProvider();
		let dynamicModels: readonly Model<"google-cloud-code-pa">[] = [];

		if (provider.refreshModels) {
			await provider.refreshModels({
				credential: {
					type: "oauth",
					access: activeCreds!.access_token,
					refresh: "mock-refresh",
					expires: Date.now() + 3600000,
					projectId: "aicode-consumers",
				},
				signal: new AbortController().signal,
				allowNetwork: true,
				force: true,
				publish: async ({ update }) => {
					update?.();
					return true;
				},
			});
			dynamicModels = provider.getModels();
		}

		expect(dynamicModels.length).toBeGreaterThan(0);
		const ids = dynamicModels.map((m) => m.id);
		expect(ids).toContain("gemini-3.5-flash-lite");
	});

	it.skipIf(!activeCreds?.access_token)(
		"streams real completion from Google Cloud Code PA",
		async () => {
			const model: Model<"google-cloud-code-pa"> = {
				id: "gemini-3.5-flash-lite",
				name: "Gemini 3.5 Flash Lite",
				api: "google-cloud-code-pa",
				provider: "antigravity",
				baseUrl: "https://daily-cloudcode-pa.googleapis.com",
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				reasoning: false,
				contextWindow: 1048576,
				maxTokens: 65536,
			};

			const context: TranscriptContext = normalizeContext({
				messages: [
					{
						role: "user",
						content: "Respond with exactly the single word: PONG",
						timestamp: Date.now(),
					},
				],
			});

			const eventStream = stream(model, context, {
				apiKey: JSON.stringify({
					token: activeCreds!.access_token,
					projectId: "aicode-consumers",
				}),
			});

			const message = await eventStream.result();
			expect(message.content.length).toBeGreaterThan(0);
			const textBlock = message.content.find((b) => b.type === "text");
			expect(textBlock).toBeDefined();
			expect((textBlock as { text: string }).text.toUpperCase()).toContain("PONG");
			expect(message.usage.input).toBeGreaterThan(0);
			expect(message.usage.output).toBeGreaterThan(0);
		},
		30000,
	);
});
