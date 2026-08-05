/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file config.ts
 * @brief MCP safety configuration - the guardrails that keep an LLM-driven
 *        client from generating unbounded real traffic. See docs/engine/mcp.md
 *        ("Safety model"). Enforced entirely in this MCP layer; the engine is
 *        never modified.
 */

/** Safety policy applied to every network-touching MCP tool. */
export interface McpSafetyConfig {
	/**
	 * Hosts an agent is permitted to send traffic to (hostnames, no scheme or
	 * port), e.g. `["api.example.com", "localhost"]`. **Empty by default** - an
	 * empty allowlist denies all outbound requests, so a fresh install cannot be
	 * used to hit arbitrary targets. The agent receives an actionable error and
	 * asks the user to add the host.
	 */
	allowlist: string[];
	/**
	 * When true, the allowlist is bypassed and an agent may target **any**
	 * resolvable host. Off by default - this trades the safe-by-default posture
	 * for convenience, so it is an explicit opt-in. Unresolved `{{variables}}` are
	 * still rejected.
	 */
	allowAll: boolean;
	/** Hard ceiling on `targetRps` for `start_load_run` (constant_rps mode). */
	maxRps: number;
	/**
	 * Hard ceiling on `concurrency` for closed-loop load modes, and on the
	 * `startConcurrency` a ramp is seeded with.
	 */
	maxConcurrency: number;
	/** Hard ceiling on a load run's duration, in seconds. */
	maxDurationSeconds: number;
	/**
	 * Hard ceiling on `iterations` for an iterations-mode run. Its own cap
	 * because that mode stops on a request count and never reads `duration`, so
	 * `maxDurationSeconds` cannot bound it - see `checkLoadCaps`.
	 */
	maxIterations: number;
	/**
	 * Gates data-mutating tools (`create_request`, `update_environment`,
	 * `update_engine_config`). When false (default), those tools refuse. It does
	 * **not** gate traffic-sending tools (`run_request`, `run_collection_smoke`)
	 * or load runs - those are governed by the allowlist, the hard caps, and the
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
	// Ten times the engine's own default of 1000 iterations: an ordinary run an
	// agent sizes for itself passes, and one that mistook the field for
	// "unlimited" does not.
	maxIterations: 10000,
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
 * well-formed fields survive - every other input is ignored rather than trusted.
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
	if (isFiniteNumber(input.maxIterations) && input.maxIterations > 0) {
		out.maxIterations = Math.floor(input.maxIterations);
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

/**
 * The environment variable each safety field is read from by the stdio CLI.
 * Lives beside the sanitizer so a value it drops can be named back to the
 * operator without re-parsing the environment.
 */
const SAFETY_ENV_VARS = {
	allowlist: "VAYU_MCP_ALLOWLIST",
	allowAll: "VAYU_MCP_ALLOW_ALL",
	maxRps: "VAYU_MCP_MAX_RPS",
	maxConcurrency: "VAYU_MCP_MAX_CONCURRENCY",
	maxDurationSeconds: "VAYU_MCP_MAX_DURATION_SECONDS",
	maxIterations: "VAYU_MCP_MAX_ITERATIONS",
	allowWrites: "VAYU_MCP_ALLOW_WRITES",
	disabledTools: "VAYU_MCP_DISABLED_TOOLS",
} as const satisfies Record<keyof McpSafetyConfig, string>;

/** An environment variable the sanitizer rejected, so the CLI can say so. */
export interface IgnoredSafetyEnvVar {
	/** The `VAYU_MCP_*` variable name. */
	variable: string;
	/** Its raw value, as it appeared in the environment. */
	value: string;
	/** The default that applies in its place. */
	fallback: McpSafetyConfig[keyof McpSafetyConfig];
}

/** A safety config built from the environment, plus what was thrown away. */
export interface EnvSafetyConfig {
	config: McpSafetyConfig;
	ignored: IgnoredSafetyEnvVar[];
}

function readSafetyFromEnv(env: NodeJS.ProcessEnv): Partial<McpSafetyConfig> {
	const cfg: Partial<McpSafetyConfig> = {};
	if (env.VAYU_MCP_ALLOWLIST) {
		cfg.allowlist = env.VAYU_MCP_ALLOWLIST.split(",")
			.map((h) => h.trim())
			.filter(Boolean);
	}
	if (env.VAYU_MCP_MAX_RPS) cfg.maxRps = Number(env.VAYU_MCP_MAX_RPS);
	if (env.VAYU_MCP_MAX_CONCURRENCY) cfg.maxConcurrency = Number(env.VAYU_MCP_MAX_CONCURRENCY);
	if (env.VAYU_MCP_MAX_DURATION_SECONDS)
		cfg.maxDurationSeconds = Number(env.VAYU_MCP_MAX_DURATION_SECONDS);
	if (env.VAYU_MCP_MAX_ITERATIONS) cfg.maxIterations = Number(env.VAYU_MCP_MAX_ITERATIONS);
	if (env.VAYU_MCP_ALLOW_ALL === "true") cfg.allowAll = true;
	if (env.VAYU_MCP_ALLOW_WRITES === "true") cfg.allowWrites = true;
	if (env.VAYU_MCP_DISABLED_TOOLS) {
		cfg.disabledTools = env.VAYU_MCP_DISABLED_TOOLS.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
	}
	return cfg;
}

/**
 * Build the stdio CLI's safety config from environment variables. The env is an
 * untrusted source exactly like the renderer and the persisted config file, so
 * it passes through `sanitizeSafetyInput` for the same reason they do: without
 * it, `Number("1,000")` is `NaN` and every `checkLoadCaps` comparison against
 * that cap is `false`, i.e. the cap silently stops existing rather than falling
 * back to its default.
 *
 * Anything the sanitizer rejects is reported in `ignored` so the CLI can tell a
 * headless operator which default applied, rather than leaving them to discover
 * it from an uncapped run.
 */
export function buildSafetyConfigFromEnv(env: NodeJS.ProcessEnv): EnvSafetyConfig {
	const raw = readSafetyFromEnv(env);
	const sanitized = sanitizeSafetyInput(raw);
	const ignored: IgnoredSafetyEnvVar[] = [];
	for (const key of Object.keys(raw) as (keyof McpSafetyConfig)[]) {
		if (sanitized[key] !== undefined) continue;
		const variable = SAFETY_ENV_VARS[key];
		ignored.push({
			variable,
			value: env[variable] ?? "",
			fallback: DEFAULT_MCP_SAFETY_CONFIG[key],
		});
	}
	return { config: resolveSafetyConfig(sanitized), ignored };
}
