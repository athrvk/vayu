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
	/** Hard ceiling on `targetRps` for `start_load_run` (constant_rps mode). */
	maxRps: number;
	/** Hard ceiling on `concurrency` for closed-loop load modes. */
	maxConcurrency: number;
	/** Hard ceiling on a load run's duration, in seconds. */
	maxDurationSeconds: number;
	/**
	 * When false (default), collection/environment write tools are disabled and
	 * load runs require an explicit `confirmed: true`. Read + single-request
	 * execution are always available (subject to the allowlist).
	 */
	allowWrites: boolean;
}

/**
 * Conservative defaults: no reachable targets, modest caps, no writes. A user
 * opts into more via app Settings (persisted separately). These mirror the
 * "safe by default" posture documented in SECURITY.md.
 */
export const DEFAULT_MCP_SAFETY_CONFIG: McpSafetyConfig = {
	allowlist: [],
	maxRps: 1000,
	maxConcurrency: 200,
	maxDurationSeconds: 300,
	allowWrites: false,
};

/** Merge a partial override (e.g. from Settings) onto the safe defaults. */
export function resolveSafetyConfig(override?: Partial<McpSafetyConfig>): McpSafetyConfig {
	return { ...DEFAULT_MCP_SAFETY_CONFIG, ...(override ?? {}) };
}
