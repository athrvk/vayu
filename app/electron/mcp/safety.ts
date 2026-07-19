/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file safety.ts
 * @brief Pure guard functions for the MCP layer: allowlist enforcement, load
 *        cap checks, and duration parsing. No I/O and no Electron imports, so
 *        this module is unit-testable in isolation.
 */

import type { McpSafetyConfig } from "./config.js";

/** Result of a guard check. `ok: false` carries a message meant for the agent. */
export interface GuardResult {
	ok: boolean;
	error?: string;
}

const OK: GuardResult = { ok: true };

/**
 * Extract the lowercased hostname from a request URL. Returns null when the URL
 * cannot be parsed — which notably includes URLs still containing unresolved
 * `{{variable}}` templates, so those are treated as "unknown host" and denied.
 */
export function extractHost(url: string): string | null {
	if (typeof url !== "string" || url.trim() === "") return null;
	// Unresolved template variables cannot be safety-checked.
	if (url.includes("{{") || url.includes("}}")) return null;
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		// Allow scheme-less inputs like "api.example.com/users".
		try {
			return new URL(`http://${url}`).hostname.toLowerCase();
		} catch {
			return null;
		}
	}
}

/**
 * Enforce the target allowlist. An empty allowlist denies everything (safe
 * default). Matching is exact on hostname, case-insensitive.
 */
export function checkAllowlist(url: string, config: McpSafetyConfig): GuardResult {
	const host = extractHost(url);
	if (!host) {
		return {
			ok: false,
			error: "Could not determine the target host from the request URL (it may be empty or contain unresolved {{variables}}). Resolve the URL before sending.",
		};
	}
	// "Allow all" bypasses the allowlist entirely (still requires a resolvable host).
	if (config.allowAll) {
		return OK;
	}
	if (config.allowlist.length === 0) {
		return {
			ok: false,
			error: `The MCP target allowlist is empty, so no outbound requests are permitted. Ask the user to add "${host}" to Vayu's MCP allowlist (Settings) before retrying.`,
		};
	}
	const allowed = config.allowlist.some((h) => h.trim().toLowerCase() === host);
	if (!allowed) {
		return {
			ok: false,
			error: `Host "${host}" is not on Vayu's MCP allowlist. Allowed hosts: ${config.allowlist.join(
				", "
			)}. Ask the user to add it in Settings before retrying.`,
		};
	}
	return OK;
}

/**
 * Parse an engine duration string ("60s", "5m", "1h", or a bare number of
 * seconds) into seconds. Returns null for unparseable input.
 */
export function parseDurationSeconds(value: string | number | undefined): number | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
	const trimmed = value.trim().toLowerCase();
	if (trimmed === "") return null;
	const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(trimmed);
	if (!match) return null;
	const n = parseFloat(match[1]);
	switch (match[2]) {
		case "ms":
			return n / 1000;
		case "m":
			return n * 60;
		case "h":
			return n * 3600;
		case "s":
		case undefined:
		default:
			return n;
	}
}

/** Parameters extracted from a `start_load_run` request, for cap checking. */
export interface LoadRunParams {
	mode?: string;
	targetRps?: number;
	concurrency?: number;
	duration?: string | number;
	rampUpDuration?: string | number;
	iterations?: number;
}

/**
 * Enforce the hard load caps (RPS / concurrency / duration). Returns the first
 * violation found, with a message naming the offending value and the ceiling.
 */
export function checkLoadCaps(params: LoadRunParams, config: McpSafetyConfig): GuardResult {
	if (typeof params.targetRps === "number" && params.targetRps > config.maxRps) {
		return {
			ok: false,
			error: `targetRps ${params.targetRps} exceeds the MCP cap of ${config.maxRps}. Lower it or raise the cap in Settings.`,
		};
	}
	if (typeof params.concurrency === "number" && params.concurrency > config.maxConcurrency) {
		return {
			ok: false,
			error: `concurrency ${params.concurrency} exceeds the MCP cap of ${config.maxConcurrency}. Lower it or raise the cap in Settings.`,
		};
	}
	const durationSeconds = parseDurationSeconds(params.duration);
	if (durationSeconds !== null && durationSeconds > config.maxDurationSeconds) {
		return {
			ok: false,
			error: `duration ${params.duration} (${durationSeconds}s) exceeds the MCP cap of ${config.maxDurationSeconds}s. Shorten it or raise the cap in Settings.`,
		};
	}
	return OK;
}
