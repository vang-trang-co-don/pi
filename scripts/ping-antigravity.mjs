#!/usr/bin/env node
/**
 * Utility script to ping all Google Antigravity models via Google Cloud Code PA
 * to determine live availability and detect when newly introduced/unlocked models become active.
 *
 * Usage:
 *   node scripts/ping-antigravity.mjs [--all]
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const USER_AGENT = "antigravity/cli/1.4.12 (aidev_client; os_type=linux; arch=amd64; cl=1010700967; auth_method=consumer)";
const BASE_URL = "https://cloudcode-pa.googleapis.com";
const DEFAULT_PROJECT = "aicode-consumers";

function loadAuth() {
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	if (!existsSync(authPath)) {
		throw new Error(`Auth file not found at ${authPath}. Run 'pi-dev' or log in to Antigravity first.`);
	}
	const content = JSON.parse(readFileSync(authPath, "utf-8"));
	const antigravity = content.antigravity;
	if (!antigravity || !antigravity.access) {
		throw new Error("Antigravity credentials not found in auth.json");
	}
	return {
		accessToken: antigravity.access,
		refreshToken: antigravity.refresh,
		projectId: antigravity.projectId || DEFAULT_PROJECT,
	};
}

async function fetchRawModels(accessToken, projectId) {
	const res = await fetch(`${BASE_URL}/v1internal:fetchAvailableModels`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			"User-Agent": USER_AGENT,
		},
		body: JSON.stringify({ project: projectId }),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`fetchAvailableModels failed (${res.status}): ${text}`);
	}

	const data = await res.json();
	return data.models || {};
}

async function pingModel(modelId, accessToken, projectId) {
	const startTime = Date.now();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 20_000);

	const isClaude = modelId.startsWith("claude-");
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		"User-Agent": USER_AGENT,
		...(isClaude ? { "anthropic-beta": "interleaved-thinking-2025-05-14" } : {}),
	};

	const body = {
		project: projectId,
		model: modelId,
		request: {
			contents: [
				{
					role: "user",
					parts: [{ text: "Ping test. Reply with the exact word PONG and nothing else." }],
				},
			],
			generationConfig: {
				maxOutputTokens: 64,
			},
		},
		requestType: "agent",
		userAgent: "antigravity",
		requestId: `ping-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	};

	try {
		const res = await fetch(`${BASE_URL}/v1internal:streamGenerateContent?alt=sse`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		clearTimeout(timeout);
		const latency = ((Date.now() - startTime) / 1000).toFixed(1) + "s";

		if (!res.ok) {
			const text = await res.text();
			let note = text.slice(0, 80);
			try {
				const json = JSON.parse(text);
				if (json.error?.message) note = json.error.message;
			} catch {}
			return {
				model: modelId,
				status: "FAILED",
				latency,
				note: `HTTP ${res.status}: ${note}`,
			};
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let responseText = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = decoder.decode(value, { stream: true });
			const lines = chunk.split("\n");
			for (const line of lines) {
				if (line.startsWith("data: ")) {
					try {
						const eventData = JSON.parse(line.slice(6));
						const parts = eventData.candidates?.[0]?.content?.parts || [];
						for (const part of parts) {
							if (part.text) responseText += part.text;
						}
					} catch {}
				}
			}
		}

		const trimmed = responseText.trim();
		if (trimmed.toLowerCase().includes("no longer available")) {
			return {
				model: modelId,
				status: "DEPRECATED",
				latency,
				note: trimmed,
			};
		}

		return {
			model: modelId,
			status: "AVAILABLE",
			latency,
			note: trimmed.replace(/\n+/g, " ").slice(0, 60),
		};
	} catch (err) {
		clearTimeout(timeout);
		const latency = ((Date.now() - startTime) / 1000).toFixed(1) + "s";
		if (err.name === "AbortError") {
			return { model: modelId, status: "TIMEOUT", latency: ">20s", note: "Request timed out" };
		}
		return { model: modelId, status: "FAILED", latency, note: err.message };
	}
}

async function main() {
	console.log("Loading Antigravity credentials...");
	const { accessToken, projectId } = loadAuth();

	console.log(`Querying model catalog from ${BASE_URL}...`);
	const rawModels = await fetchRawModels(accessToken, projectId);

	const includeAll = process.argv.includes("--all");
	const candidates = Object.keys(rawModels).filter((id) => {
		if (id.startsWith("MODEL_") || id.startsWith("chat_") || id.startsWith("tab_")) {
			return false;
		}
		if (!includeAll && (id.endsWith("-low") || id.endsWith("-medium") || id.endsWith("-high") || id.endsWith("-thinking"))) {
			return false;
		}
		return true;
	});

	console.log(`Discovered ${candidates.length} candidate models to ping:\n`);

	const results = [];
	for (const id of candidates) {
		process.stdout.write(`Pinging [${id}]... `);
		const result = await pingModel(id, accessToken, projectId);
		results.push(result);
		console.log(`${result.status === "AVAILABLE" ? "✅" : "❌"} ${result.status} (${result.latency}) -> ${result.note}`);
	}

	console.log("\n" + "=".repeat(75));
	console.log(" ANTIGRAVITY LIVE MODEL AVAILABILITY MATRIX");
	console.log("=".repeat(75));
	console.table(results);
}

main().catch((err) => {
	console.error("Error:", err);
	process.exit(1);
});
