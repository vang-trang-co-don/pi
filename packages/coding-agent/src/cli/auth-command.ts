import type { AuthResult } from "@earendil-works/pi-ai";
import { APP_NAME } from "../config.ts";
import type { Args } from "./args.ts";

export type AuthCommandKind = "check" | "api_key" | "bearer_token" | "accounts" | "switch" | "usage";

export interface AuthCommand {
	kind: AuthCommandKind;
	args: string[];
	json: boolean;
	credentials: boolean;
	noRefresh: boolean;
	minExpiryMs?: number;
}

export class AuthCommandError extends Error {}

const AUTH_COMMAND_USAGE: Record<AuthCommandKind, string> = {
	check: `${APP_NAME} auth check --provider <provider> [--json] [--credentials] [--no-refresh]`,
	api_key: `${APP_NAME} auth print-api-key --provider <provider> [--model <model>]`,
	bearer_token: `${APP_NAME} auth print-bearer-token --provider <provider> [--model <model>] [--min-expiry <duration>]`,
	accounts: `${APP_NAME} auth accounts [--provider <provider>] [--json]`,
	switch: `${APP_NAME} auth switch --provider <provider> --account <accountId>`,
	usage: `${APP_NAME} auth usage [--provider <provider>] [--account <account>] [--json]`,
};

export function getAuthCommandName(kind: AuthCommandKind): string {
	return kind === "check"
		? "auth check"
		: kind === "api_key"
			? "auth print-api-key"
			: kind === "bearer_token"
				? "auth print-bearer-token"
				: kind === "accounts"
					? "auth accounts"
					: kind === "switch"
						? "auth switch"
						: "auth usage";
}

export function getAuthCommandUsage(kind: AuthCommandKind): string {
	return AUTH_COMMAND_USAGE[kind];
}

export function isAuthCommandHelp(args: string[]): boolean {
	return (
		args[0] === "auth" &&
		(args[1] === undefined || args[1] === "help" || args.includes("--help") || args.includes("-h"))
	);
}

export function printAuthCommandHelp(): void {
	console.log(`Usage:
  pi auth accounts [--provider <provider>] [--json]
  pi auth switch --provider <provider> --account <accountId>
  pi auth print-api-key [--provider <provider>] [--model <model>]
  pi auth print-bearer-token [--provider <provider>] [--model <model>] [--min-expiry <duration>]
  pi auth check [--provider <provider>] [--model <model>] [--json] [--credentials] [--no-refresh]

Auth commands manage provider accounts, check readiness, or print credentials.`);
}

export function parseAuthCommand(args: string[]): AuthCommand | undefined {
	if (args[0] !== "auth" && args[0] !== "usage") return undefined;

	let kind: AuthCommandKind | undefined;
	let startIndex = 2;

	if (args[0] === "usage") {
		kind = "usage";
		startIndex = 1;
	} else if (args[1] === "usage") {
		kind = "usage";
		startIndex = 2;
	} else {
		kind =
			args[1] === "check"
				? "check"
				: args[1] === "print-api-key"
					? "api_key"
					: args[1] === "print-bearer-token"
						? "bearer_token"
						: args[1] === "accounts"
							? "accounts"
							: args[1] === "switch"
								? "switch"
								: undefined;
	}
	if (!kind) {
		throw new AuthCommandError(
			`Unknown auth command "${args[1] ?? ""}". Use "${APP_NAME} auth accounts", "${APP_NAME} auth switch", "${APP_NAME} auth usage", "${APP_NAME} auth print-api-key", or "${APP_NAME} auth check".`,
		);
	}

	const commandArgs: string[] = [];
	let json = false;
	let credentials = false;
	let noRefresh = false;
	let minExpiryMs: number | undefined;
	for (let index = startIndex; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--min-expiry") {
			if (kind !== "bearer_token")
				throw new AuthCommandError("--min-expiry is only supported by print-bearer-token");
			const value = args[++index];
			const match = value ? /^(\d+)(ms|s|m|h)$/iu.exec(value) : undefined;
			if (!match) throw new AuthCommandError("--min-expiry must use a duration such as 30m or 1h");
			const amount = Number(match[1]);
			const unit = match[2];
			minExpiryMs = amount * (unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000);
			continue;
		}
		if (arg === "--json" || arg === "--credentials" || arg === "--no-refresh") {
			if (arg === "--json") {
				json = true;
			} else if (arg === "--credentials") {
				if (kind !== "check") throw new AuthCommandError(`${arg} is only supported by auth check`);
				credentials = true;
			} else {
				if (kind !== "check") throw new AuthCommandError(`${arg} is only supported by auth check`);
				noRefresh = true;
			}
			continue;
		}
		commandArgs.push(arg);
	}

	return minExpiryMs === undefined
		? { kind, args: commandArgs, json, credentials, noRefresh }
		: { kind, args: commandArgs, json, credentials, noRefresh, minExpiryMs };
}

export function validateAuthCommandArgs(args: Args, kind: AuthCommandKind): { provider?: string; model?: string } {
	const provider = args.provider?.trim() || undefined;
	const model = args.model?.trim() || undefined;
	if (args.unknownFlags.size > 0) {
		const option = args.unknownFlags.keys().next().value;
		throw new AuthCommandError(`Unknown option --${option} for "${getAuthCommandName(kind)}".`);
	}
	if (args.apiKey !== undefined || args.messages.length > 0 || args.fileArgs.length > 0) {
		throw new AuthCommandError("Auth commands only accept --provider and --model");
	}
	if (kind === "check") {
		if (!provider && !model) {
			throw new AuthCommandError("Auth checks require --provider <provider> or --model <model>");
		}
		return { provider, model };
	}
	if (!provider && !model) {
		throw new AuthCommandError("Credential printing requires --provider <provider> or --model <model>");
	}
	return { provider, model };
}

export function getAuthCredential(auth: AuthResult | undefined): string | undefined {
	if (auth?.auth.apiKey) return auth.auth.apiKey;
	const authorization = Object.entries(auth?.auth.headers ?? {}).find(
		([name]) => name.toLowerCase() === "authorization",
	)?.[1];
	return typeof authorization === "string" ? /^Bearer\s+(.+)$/iu.exec(authorization)?.[1] : undefined;
}
