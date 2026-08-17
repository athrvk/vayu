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
	 * port), e.g. `["api.example.com", "localhost"]`. An IPv6 target is stored in
	 * the bracketed form `URL.hostname` produces, e.g. `["[::1]"]` - see
	 * `normalizeHost`. **Empty by default** - an empty allowlist denies all
	 * outbound requests, so a fresh install cannot be used to hit arbitrary
	 * targets. The agent receives an actionable error and asks the user to add
	 * the host.
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
	 * Gates every tool in the `write` category - the collection and saved-request
	 * CRUD verbs, `update_environment` and `update_engine_config`. When false
	 * (default), those tools refuse; the two deletes additionally require
	 * confirmation even with it on. It does **not** gate traffic-sending tools
	 * (`run_request`, `run_collection_smoke`, `run_collection`) or load runs -
	 * those are governed by the allowlist, the hard caps, and the load-run
	 * confirmation gate independently.
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
 * Whether `host` (scheme, path and query already stripped) is meant as an IPv6
 * literal rather than a name with a port: either it is bracketed, or it is bare
 * with more than one colon, which no `name:port` can be.
 */
function isIpv6Candidate(host: string): boolean {
	return host.startsWith("[") || (host.match(/:/g)?.length ?? 0) > 1;
}

/**
 * The bracketed IPv6 literal `host` denotes, canonicalized the way WHATWG
 * `URL.hostname` serializes it (`[0:0:0:0:0:0:0:1]` → `[::1]`) - which is what
 * `extractHost` compares against, so a stored entry has to be in that exact
 * form to ever match. `""` for anything unparseable, which the sanitizer's
 * empty filter then drops rather than persisting garbage.
 */
function normalizeIpv6(host: string): string {
	let literal = host;
	if (literal.startsWith("[")) {
		const close = literal.indexOf("]");
		if (close === -1) return "";
		// Only a port may follow the literal; anything else is malformed input.
		const trailing = literal.slice(close + 1);
		if (trailing !== "" && !/^:\d*$/.test(trailing)) return "";
		literal = literal.slice(0, close + 1);
	} else {
		// A bare address is the whole input: RFC 3986 has no unbracketed form
		// that could carry a port, so there is nothing here to strip.
		literal = `[${host}]`;
	}
	try {
		return new URL(`http://${literal}`).hostname;
	} catch {
		return "";
	}
}

/**
 * Reduce a user-entered value to a bare hostname: strip scheme, path, query,
 * and port, then lowercase. `"https://api.example.com:8080/v1"` → `"api.example.com"`.
 * Matches the exact-hostname comparison the allowlist guard performs, so what the
 * user types in Settings lines up with what an agent's request URL resolves to.
 *
 * An IPv6 target normalizes to its **bracketed** canonical form (`"::1"`,
 * `"[::1]:9876"` and `"http://[::1]:8080"` all → `"[::1]"`), because that is how
 * `URL.hostname` serializes it on the guard's side. Stripping the port by the
 * first colon would leave `""` or `"["` and no such entry could ever match.
 */
export function normalizeHost(raw: string): string {
	let host = raw.trim().toLowerCase();
	if (host === "") return "";
	host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme://
	host = host.split("/")[0].split("?")[0]; // path / query
	if (isIpv6Candidate(host)) return normalizeIpv6(host);
	host = host.split(":")[0]; // port
	return host.trim();
}

function isFiniteNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

/** The four numeric caps, which share one range rule. */
export type McpCapKey = "maxRps" | "maxConcurrency" | "maxDurationSeconds" | "maxIterations";

const MCP_CAP_KEYS: readonly McpCapKey[] = [
	"maxRps",
	"maxConcurrency",
	"maxDurationSeconds",
	"maxIterations",
];

/**
 * The highest value each cap may hold - the maxima of the renderer's
 * `LOAD_TEST_CEILING_BOUNDS`, which are the engine's own guards where the engine
 * has one (`concurrency` at 10x `event_loop::MAX_CONCURRENT`, `durationSeconds`
 * at the per-transfer timeout guard) and the point past which a single desktop
 * engine is the wrong tool where it does not.
 *
 * A cap above its ceiling is not a looser policy, it is an absent one: the value
 * it would admit is refused by the engine or beyond anything Vayu will compose
 * anyway, and the user is left believing a guardrail exists where none does. So
 * the sanitizer holds each cap at its ceiling rather than storing it.
 *
 * Literals rather than an import because production code in `electron/` may not
 * reach into `src/` - `tsconfig.node.json` withholds the `@/*` mapping on
 * purpose - the same reason `MAX_IN_FLIGHT_BOUND` in `tools.ts` is a literal.
 * The copies are kept honest from the test side: `config.test.ts` ties these to
 * the renderer constant, and `load-test.engine-parity.test.ts` ties that to the
 * engine header.
 */
export const MCP_CAP_CEILINGS = {
	maxRps: 1_000_000,
	maxConcurrency: 10_000,
	maxDurationSeconds: 86_400,
	maxIterations: 100_000_000,
} as const satisfies Record<McpCapKey, number>;

/**
 * A cap as a whole number inside its ceiling, or undefined when the input is not
 * a usable cap at all (non-numeric, zero, negative, NaN) - which the caller
 * drops, leaving the default in force rather than a cap that cannot fire.
 */
function clampCap(key: McpCapKey, value: unknown): number | undefined {
	if (!isFiniteNumber(value) || value <= 0) return undefined;
	return Math.min(Math.floor(value), MCP_CAP_CEILINGS[key]);
}

/**
 * Sanitize a partial safety override arriving from the (untrusted) renderer
 * before it is applied or persisted: normalize + de-duplicate allowlist hosts,
 * hold caps to whole numbers between 1 and their ceiling, and drop anything
 * malformed. Only recognized, well-formed fields survive - every other input is
 * ignored rather than trusted.
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
	for (const key of MCP_CAP_KEYS) {
		const cap = clampCap(key, input[key]);
		if (cap !== undefined) out[key] = cap;
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

/**
 * An environment variable whose cap the sanitizer held at its ceiling. Its own
 * shape rather than a reuse of `IgnoredSafetyEnvVar`: nothing fell back here, so
 * that type's `fallback` would have to name a default that never applied.
 */
export interface ClampedSafetyEnvVar {
	/** The `VAYU_MCP_*` variable name. */
	variable: string;
	/** Its raw value, as it appeared in the environment. */
	value: string;
	/** The cap actually in force - the key's ceiling. */
	applied: number;
}

/**
 * A safety config built from the environment, plus every way it differs from
 * what was asked for: `ignored` for variables that fell back to their default,
 * `clamped` for caps that are in force at a lower value than requested. The two
 * are separate channels because they are separate outcomes - a reader that
 * merged them could not tell an operator which of the two happened.
 */
export interface EnvSafetyConfig {
	config: McpSafetyConfig;
	ignored: IgnoredSafetyEnvVar[];
	clamped: ClampedSafetyEnvVar[];
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
 * it from an uncapped run. A cap held at its ceiling is reported in `clamped`
 * for the same reason one step further along: the run is bounded at a value the
 * operator did not type, and without a line saying so the first evidence is a
 * refused run.
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
	const clamped: ClampedSafetyEnvVar[] = [];
	for (const key of MCP_CAP_KEYS) {
		const requested = raw[key];
		const applied = sanitized[key];
		if (applied === undefined || !isFiniteNumber(requested)) continue;
		// Against the *floored* request, not the raw one: flooring `1000.7` to
		// `1000` is not a ceiling being applied, and reporting it as one would
		// name a maximum the value never came near. Derived from the sanitizer's
		// own output rather than re-compared against `MCP_CAP_CEILINGS`, so the
		// ceilings keep exactly one definition.
		if (applied >= Math.floor(requested)) continue;
		const variable = SAFETY_ENV_VARS[key];
		clamped.push({ variable, value: env[variable] ?? "", applied });
	}
	return { config: resolveSafetyConfig(sanitized), ignored, clamped };
}

/**
 * The stderr lines the stdio CLI prints for an environment that did not survive
 * sanitization intact - one per ignored variable, then one per clamped cap.
 * Separate from `cli.ts` because that module runs a server on import and so
 * cannot be exercised by a test; this is the part worth pinning.
 */
export function formatSafetyEnvNotices({ ignored, clamped }: EnvSafetyConfig): string[] {
	return [
		...ignored.map(
			({ variable, value, fallback }) =>
				`[vayu-mcp] ignoring malformed ${variable}=${JSON.stringify(value)} (using default ${JSON.stringify(fallback)})`
		),
		...clamped.map(
			({ variable, value, applied }) =>
				`[vayu-mcp] ${variable}=${JSON.stringify(value)} is above the maximum of ${applied}; running with ${applied}`
		),
	];
}
