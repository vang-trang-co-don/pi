import { compare, valid } from "semver";
import { fetchWithRetry } from "./management-http.ts";
import { getPiUserAgent } from "./pi-user-agent.ts";

const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const GITHUB_CUSTOM_RELEASES_URL = "https://api.github.com/repos/vang-trang-co-don/pi/releases";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestPiRelease {
	version: string;
	packageName?: string;
	note?: string;
}

/** Include useful errno details hidden behind Node's generic "fetch failed" error. */
export function formatVersionCheckError(error: unknown): string {
	const rootMessage = error instanceof Error && error.message ? error.message : String(error);
	const cause = error instanceof Error ? error.cause : undefined;
	const causes = cause instanceof AggregateError ? cause.errors : cause === undefined ? [] : [cause];
	const codes = causes
		.map((value) =>
			typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
				? value.code
				: undefined,
		)
		.filter((code): code is string => code !== undefined);

	if (codes.length > 0) return `${rootMessage} (${[...new Set(codes)].join(", ")})`;
	const causeMessage = causes.find(
		(value): value is Error => value instanceof Error && Boolean(value.message),
	)?.message;
	return causeMessage ? `${rootMessage} (cause: ${causeMessage})` : rootMessage;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestPiRelease(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_OFFLINE) return undefined;

	const response = await fetchWithRetry(
		LATEST_VERSION_URL,
		{
			headers: {
				"User-Agent": getPiUserAgent(currentVersion),
				accept: "application/json",
			},
		},
		{
			maxRetries: options.retry ? 2 : 0,
			timeoutMs: options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS,
		},
	);
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		packageName?: unknown;
		version?: unknown;
		note?: unknown;
	};
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const packageName =
		typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
	return {
		version: data.version.trim(),
		packageName,
		...(note ? { note } : {}),
	};
}

export async function getLatestPiVersion(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

export async function checkForNewPiVersion(currentVersion: string): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_SKIP_VERSION_CHECK) return undefined;

	// In test environments or when explicitly configured, keep checks standard
	if (process.env.NODE_ENV === "test" || process.env.VITEST) {
		try {
			const latestRelease = await getLatestPiRelease(currentVersion);
			if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
				return latestRelease;
			}
			return undefined;
		} catch {
			return undefined;
		}
	}

	// Check custom fork releases first (nightly or latest custom releases)
	try {
		const customRelease = await getLatestCustomForkRelease(currentVersion);
		if (customRelease) {
			return customRelease;
		}
	} catch {
		// Fall through to standard version check
	}

	try {
		const latestRelease = await getLatestPiRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

interface GitHubReleaseItem {
	tag_name?: string;
	name?: string;
	body?: string;
	prerelease?: boolean;
	draft?: boolean;
}

export async function getLatestCustomForkRelease(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_OFFLINE) return undefined;

	try {
		const response = await fetchWithRetry(
			GITHUB_CUSTOM_RELEASES_URL,
			{
				headers: {
					"User-Agent": getPiUserAgent(currentVersion),
					accept: "application/vnd.github.v3+json",
				},
			},
			{
				maxRetries: 0,
				timeoutMs: options.timeoutMs ?? 5000,
			},
		);
		if (!response.ok) return undefined;

		const releases = (await response.json()) as GitHubReleaseItem[];
		if (!Array.isArray(releases) || releases.length === 0) return undefined;

		// Find the first non-draft release (nightly or standard release)
		const candidate = releases.find((r) => !r.draft);
		if (!candidate || !candidate.tag_name) return undefined;

		const tag = candidate.tag_name.trim();
		// If tag is nightly, check if it's marked as prerelease or different from current version
		if (tag === "nightly") {
			const candidateTitle = candidate.name?.trim() || "";
			// If title mentions a commit SHA or Nightly, format as update
			return {
				version: candidateTitle || "nightly",
				note: candidate.body?.trim()
					? candidate.body.trim().slice(0, 300)
					: "Nightly build from latest main commit",
			};
		}

		// Otherwise check semver tag (strip leading 'v')
		const cleanVersion = tag.startsWith("v") ? tag.slice(1) : tag;
		if (isNewerPackageVersion(cleanVersion, currentVersion)) {
			return {
				version: cleanVersion,
				note: candidate.body?.trim() ? candidate.body.trim().slice(0, 300) : undefined,
			};
		}
		return undefined;
	} catch {
		return undefined;
	}
}
