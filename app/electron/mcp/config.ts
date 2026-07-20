/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file config.ts
 * @brief MCP safety configuration — the guardrails that keep an LLM-driven
 *        client from generating unbounded real traffic. See docs/engine/mcp.md
 *        ("Safety model"). Enforced entirely in this MCP layer; the engine is
 *        never modified.
 */

/** Safety policy applied to every network-touching MCP tool. */
export interface McpSafetyConfig {
	/**
	 * Hosts an agent is permitted to send traffic to (hostnames, no scheme or
	 * port), e.g. `["api.example.com", "localhost"]`. **Empty by default** — an
	 * empty allowlist denies all outbound requests, so a fresh install cannot be
	 * used to hit arbitrary targets. The agent receives an actionable error and
	 * asks the user to add the host.
	 */
	allowlist: string[];
	/**
	 * When true, the allowlist is bypassed and an agent may target **any**
	 * resolvable host. Off by default — this trades the safe-by-default posture
	 * for convenience, so it is an explicit opt-in. Unresolved `{{variables}}` are
	 * still rejected.
	 */
	allowAll: boolean;
	/** Hard ceiling on `targetRps` for `start_load_run` (constant_rps mode). */
	maxRps: number;
	/** Hard ceiling on `concurrency` for closed-loop load modes. */
	maxConcurrency: number;
	/** Hard ceiling on a load run's duration, in seconds. */
	maxDurationSeconds: number;
	/**
	 * Gates data-mutating tools (`create_request`, `update_environment`,
	 * `update_engine_config`). When false (default), those tools refuse. It does
	 * **not** gate traffic-sending tools (`run_request`, `run_collection_smoke`)
	 * or load runs — those are governed by the allowlist, the hard caps, and the
	 * load-run confirmation gate independently.
	 */
	allowWrites: boolean;
	/**
	 * Tool names the user has switched off. A disabled tool is omitted from
	 * `tools/list` and rejected by `tools/call`. Empty by default (all on).
	 */
	disabledTools: string[];
}

/**
 * Conservative defaults: no reachable targets, modest caps, no writes. A user
 * opts into more via app Settings (persisted separately). These mirror the
 * "safe by default" posture documented in SECURITY.md.
 */
export const DEFAULT_MCP_SAFETY_CONFIG: McpSafetyConfig = {
	allowlist: [],
	allowAll: false,
	maxRps: 1000,
	maxConcurrency: 200,
	maxDurationSeconds: 300,
	allowWrites: false,
	disabledTools: [],
};

/** Merge a partial override (e.g. from Settings) onto the safe defaults. */
export function resolveSafetyConfig(override?: Partial<McpSafetyConfig>): McpSafetyConfig {
	return { ...DEFAULT_MCP_SAFETY_CONFIG, ...(override ?? {}) };
}

/**
 * Reduce a user-entered value to a bare hostname: strip scheme, path, query,
 * and port, then lowercase. `"https://api.example.com:8080/v1"` → `"api.example.com"`.
 * Matches the exact-hostname comparison the allowlist guard performs, so what the
 * user types in Settings lines up with what an agent's request URL resolves to.
 */
export function normalizeHost(raw: string): string {
	let host = raw.trim().toLowerCase();
	if (host === "") return "";
	host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme://
	host = host.split("/")[0].split("?")[0]; // path / query
	host = host.split(":")[0]; // port
	return host.trim();
}

function isFiniteNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

/**
 * Sanitize a partial safety override arriving from the (untrusted) renderer
 * before it is applied or persisted: normalize + de-duplicate allowlist hosts,
 * clamp caps to positive integers, and drop anything malformed. Only recognized,
 * well-formed fields survive — every other input is ignored rather than trusted.
 */
export function sanitizeSafetyInput(input: Partial<McpSafetyConfig>): Partial<McpSafetyConfig> {
	const out: Partial<McpSafetyConfig> = {};

	if (Array.isArray(input.allowlist)) {
		const hosts = input.allowlist
			.filter((h): h is string => typeof h === "string")
			.map(normalizeHost)
			.filter((h) => h.length > 0);
		out.allowlist = Array.from(new Set(hosts));
	}
	if (isFiniteNumber(input.maxRps) && input.maxRps > 0) {
		out.maxRps = Math.floor(input.maxRps);
	}
	if (isFiniteNumber(input.maxConcurrency) && input.maxConcurrency > 0) {
		out.maxConcurrency = Math.floor(input.maxConcurrency);
	}
	if (isFiniteNumber(input.maxDurationSeconds) && input.maxDurationSeconds > 0) {
		out.maxDurationSeconds = Math.floor(input.maxDurationSeconds);
	}
	if (typeof input.allowAll === "boolean") {
		out.allowAll = input.allowAll;
	}
	if (typeof input.allowWrites === "boolean") {
		out.allowWrites = input.allowWrites;
	}
	if (Array.isArray(input.disabledTools)) {
		const names = input.disabledTools
			.filter((n): n is string => typeof n === "string")
			.map((n) => n.trim())
			.filter((n) => n.length > 0);
		out.disabledTools = Array.from(new Set(names));
	}
	return out;
}
