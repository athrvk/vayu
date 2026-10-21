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
import { settingRemedy } from "./remedy.js";
import type { McpHost } from "./tools/contract.js";

/** Result of a guard check. `ok: false` carries a message meant for the agent. */
export interface GuardResult {
	ok: boolean;
	error?: string;
}

const OK: GuardResult = { ok: true };

/** The lowercased hostname `candidate` parses to, or null if it yields none. */
function parseHostname(candidate: string): string | null {
	try {
		return new URL(candidate).hostname.toLowerCase() || null;
	} catch {
		return null;
	}
}

/**
 * Whether `url` still carries a `{{template}}` in the part that decides the
 * host - the authority: everything between the scheme and the first `/`, `?`
 * or `#`, which is where a userinfo, a hostname and a port live.
 *
 * The distinction is load-bearing since `run_request` gained a data row (issue
 * #601). A `{{data.id}}` in the *path* is not an unresolved variable waiting on
 * a client - it survives `POST /compose` deliberately, so the engine can bind
 * the row against it - and refusing the whole URL for one would make the row
 * unusable in the position it is most often written. What the allowlist decides
 * is the **host**, and a template after the authority cannot change it: no value
 * substituted into a path, query or fragment moves the request to another
 * server.
 *
 * A template *inside* the authority is refused exactly as before, which is the
 * case that matters: `https://{{host}}/x` names a target nothing here can know,
 * and a gate that guessed would be a gate.
 */
function authorityHasTemplate(url: string): boolean {
	const schemeEnd = url.indexOf("://");
	const authorityStart = schemeEnd === -1 ? 0 : schemeEnd + 3;
	// The first delimiter after the authority. `Infinity` for a URL that is all
	// authority ("example.com:8080"), which is then scanned whole.
	const authorityEnd = Math.min(
		...["/", "?", "#"]
			.map((delimiter) => url.indexOf(delimiter, authorityStart))
			.map((index) => (index === -1 ? Infinity : index))
	);
	const authority = url.slice(
		authorityStart,
		authorityEnd === Infinity ? undefined : authorityEnd
	);
	return authority.includes("{{") || authority.includes("}}");
}

/**
 * Extract the lowercased hostname from a request URL. Returns null when the URL
 * cannot be parsed - which includes a URL whose *authority* still carries an
 * unresolved `{{variable}}` template, so those are treated as "unknown host"
 * and denied. See {@link authorityHasTemplate} for why a template further along
 * the URL is not one of those.
 */
export function extractHost(url: string): string | null {
	if (typeof url !== "string" || url.trim() === "") return null;
	// An unresolved template in the authority cannot be safety-checked.
	if (authorityHasTemplate(url)) return null;
	const parsed = parseHostname(url);
	if (parsed) return parsed;
	// A scheme-less "localhost:3000/api" does not throw: "localhost" is a legal
	// scheme, so it parses with an empty hostname. An empty hostname is therefore
	// as unparsed as a throw, and the scheme-less retry has to cover both cases
	// or every host:port URL is refused as "unresolvable" - the shape the user
	// reads as a variable-resolution bug.
	//
	// Not for input carrying an explicit "://" though: there the empty hostname
	// is the URL's own answer ("file:///etc/passwd" is host-less), and prefixing
	// a scheme would turn it into the host "file" - a target the allowlist could
	// then be talked into permitting. Unknown hosts stay refused.
	if (url.includes("://")) return null;
	return parseHostname(`http://${url}`);
}

/**
 * Enforce the target allowlist. An empty allowlist denies everything (safe
 * default). Matching is exact on hostname, case-insensitive. @p host is the
 * session's host, which decides how the refusal tells the user to lift it.
 */
export function checkAllowlist(url: string, config: McpSafetyConfig, host: McpHost): GuardResult {
	const target = extractHost(url);
	if (!target) {
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
			error: `The MCP target allowlist is empty, so no outbound requests are permitted, "${target}" included. Ask the user to ${settingRemedy("allowlist", host)} before retrying.`,
		};
	}
	const allowed = config.allowlist.some((h) => h.trim().toLowerCase() === target);
	if (!allowed) {
		return {
			ok: false,
			error: `Host "${target}" is not on the MCP allowlist. Allowed hosts: ${config.allowlist.join(
				", "
			)}. Ask the user to ${settingRemedy("allowlist", host)} before retrying.`,
		};
	}
	return OK;
}

/**
 * The dotted quad behind an IPv4-mapped IPv6 address, else the address unchanged.
 * `URL` serializes `::ffff:127.0.0.1` as `::ffff:7f00:1`, so the hex pair is the
 * form that arrives; the dotted spelling is kept for a caller passing it directly.
 */
function unmapIpv4(address: string): string {
	const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
	if (dotted) return dotted[1];
	const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
	if (!hex) return address;
	const [high, low] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
	return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/**
 * Whether `host` names a machine on the user's own network - loopback, an
 * RFC1918 / RFC4193 private address, or a link-local one.
 *
 * The host arrives from `URL.hostname`, which normalises the alternate IPv4
 * spellings (`http://2130706433/` reports `127.0.0.1`) and brackets an IPv6
 * literal, so this reads the canonical form rather than the typed one.
 *
 * Textual, like the allowlist itself: a DNS name that *resolves* to a private
 * address is not one of these, and stays subject to the allowlist. Resolving it
 * here would make the guard's answer depend on the network it is asked on.
 */
export function isPrivateHost(host: string): boolean {
	if (host === "localhost" || host.endsWith(".localhost")) return true;

	if (host.startsWith("[") && host.endsWith("]")) {
		// An IPv4-mapped address is classified as the v4 one it wraps.
		const address = unmapIpv4(host.slice(1, -1));
		if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) return isPrivateIpv4(address);
		if (address === "::1" || address === "::") return true;
		// fc00::/7 (unique local) and fe80::/10 (link local).
		return /^f[cd][0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address);
	}

	return /^\d+\.\d+\.\d+\.\d+$/.test(host) && isPrivateIpv4(host);
}

/** RFC1918, loopback, link-local and the unspecified address, in dotted quad. */
function isPrivateIpv4(address: string): boolean {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
		return false;
	}
	const [a, b] = parts;
	if (a === 0 || a === 127) return true; // unspecified / loopback
	if (a === 10) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 169 && b === 254) return true; // link local
	return false;
}

/** AWS's IMDS endpoint over IPv6, the one metadata address outside link-local space. */
const IPV6_METADATA_ADDRESS = "fd00:ec2::254";

/**
 * Whether `host` is a link-local address, or the one IPv6 cloud-metadata
 * address that sits outside link-local space. Same canonical-form input as
 * `isPrivateHost`; this is deliberately a separate predicate so that one stays
 * the mirror `host-locality.conformance.test.ts` pins.
 *
 * These hosts count as private for "is this the user's own network" (the
 * dialog's label) but are the ones an agent could aim a scrape at to read
 * credentials: 169.254.169.254 is the metadata service on AWS, GCP and Azure,
 * and `fd00:ec2::254` is AWS's IPv6 spelling of it. Only that one address is
 * named from fc00::/7; the rest of the block is ordinary LAN space.
 */
export function isLinkLocalHost(host: string): boolean {
	if (!host.startsWith("[") || !host.endsWith("]")) {
		return /^169\.254\.\d+\.\d+$/.test(host);
	}
	const address = unmapIpv4(host.slice(1, -1));
	if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) return address.startsWith("169.254.");
	return /^fe[89ab][0-9a-f]:/.test(address) || address === IPV6_METADATA_ADDRESS;
}

/**
 * Enforce the allowlist against a run's **monitor** endpoint - the second host
 * a monitored run contacts, which is not the target's and is not covered by the
 * check on it.
 *
 * **The decision, stated rather than implied:** a loopback or private-network
 * monitor URL is exempt from the allowlist; a public one is not. The allowlist
 * exists to stop an agent generating traffic against third parties it was never
 * pointed at, and a private address is by definition the user's own network -
 * which is also the whole feature, since the endpoint a load run wants beside it
 * is the target's own `localhost:9100`. Requiring that host to be allowlisted
 * would make the capability unreachable in the case it was built for.
 *
 * **The exception (#2370):** link-local addresses (169.254.0.0/16, fe80::/10)
 * and `fd00:ec2::254` are not exempt. They are where cloud metadata services
 * answer, so a scrape of one is a credential read, not the user's exporter.
 * They go through the allowlist like a public host. The engine's own monitor
 * validation (`read_monitor_block`, `engine/src/core/monitor.cpp`) is
 * unchanged; this gate is the MCP layer's.
 *
 * A public monitor host is a request to some third party at one GET per scrape
 * for the life of the run, which is exactly what the allowlist is for, so it
 * goes through the same check the target URL does.
 */
export function checkMonitorHost(url: string, config: McpSafetyConfig, host: McpHost): GuardResult {
	const monitorHost = extractHost(url);
	if (!monitorHost) {
		return {
			ok: false,
			error: "Could not determine the host of `monitor.url` (it may be empty or contain unresolved {{variables}}). Resolve it before retrying.",
		};
	}
	if (isPrivateHost(monitorHost) && !isLinkLocalHost(monitorHost)) return OK;
	const gate = checkAllowlist(url, config, host);
	if (gate.ok) return OK;
	return {
		ok: false,
		error: `The monitor endpoint is a second host this run would contact, once per scrape: ${gate.error} (A loopback or private-network monitor URL needs no allowlist entry, except link-local and cloud-metadata addresses, which do.)`,
	};
}

/**
 * The duration *grammar* only: "60s", "5m", "1h", "500ms", or a bare number of
 * seconds, into seconds. Null when the text is not a duration at all.
 *
 * Mirrors the engine's `parse_duration_ms`
 * (`engine/include/vayu/core/load_pacing.hpp`): the same units, the same
 * bare-number-is-seconds rule, and the same acceptance of zero. They must
 * agree, or a duration this cap reads as 5 minutes runs for some other length.
 * Zero belongs here because `rampUpDuration: "0"` is a legal instant ramp - the
 * range rule that rejects a zero *run* is `parseDurationSeconds` below.
 */
function parseDurationGrammar(value: string | number | undefined): number | null {
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

/**
 * A run `duration` in seconds, or null when the engine would refuse it: the
 * grammar above plus the engine's own range rule, which requires a positive
 * magnitude (`validate_run_config`, `execution.cpp`). Zero is therefore not a
 * duration here, the same way `POST /runs` 400s it.
 */
export function parseDurationSeconds(value: string | number | undefined): number | null {
	const seconds = parseDurationGrammar(value);
	return seconds === null || seconds <= 0 ? null : seconds;
}

/** Parameters extracted from a `start_load_run` request, for cap checking. */
export interface LoadRunParams {
	mode?: string;
	targetRps?: number;
	concurrency?: number;
	startConcurrency?: number;
	duration?: string | number;
	rampUpDuration?: string | number;
	stepDuration?: string | number;
	iterations?: number;
}

/**
 * Modes the engine recognises (`parse_load_test_type`, `vayu/types.hpp`), the
 * default first. The one list behind `start_load_run`'s `mode` enum and
 * {@link KNOWN_LOAD_MODES}, so the schema and the guard cannot disagree about
 * which modes exist.
 */
export const LOAD_MODES = [
	"constant_concurrency",
	"constant_rps",
	"ramp_up",
	"iterations",
	"capacity",
] as const;

export type LoadMode = (typeof LOAD_MODES)[number];

/**
 * {@link LOAD_MODES} as a set. Anything outside it falls through
 * `LoadStrategy::create`, so the guard mirrors that fallback rather than
 * trusting the string it was given. `prompts.test.ts` measures the
 * `suggest_load_profile` prompt's enumeration against it.
 */
export const KNOWN_LOAD_MODES: ReadonlySet<string> = new Set<string>(LOAD_MODES);

function isLoadMode(mode: string): mode is LoadMode {
	return KNOWN_LOAD_MODES.has(mode);
}

/** What a strategy runs with when a shape field is absent from `POST /runs`. */
export interface EngineLoadDefaults {
	/** Virtual users; for a rate-paced mode, only when no `targetRps` paces it. */
	concurrency?: number;
	startConcurrency?: number;
	durationSeconds?: number;
	rampUpDurationSeconds?: number;
	iterations?: number;
	/** `ConstantLoadStrategy`: a positive `targetRps` runs it open-loop. */
	ratePaced?: boolean;
}

/**
 * The single-target strategies' defaults per mode, from `run_config::DEFAULT_*`
 * and `capacity::DEADLINE_MS` / `capacity::MAX_CONCURRENCY` in `constants.hpp` (`safety.test.ts` reads both).
 * A scenario run has an executor and defaults of its own
 * (`SCENARIO_LOAD_DEFAULTS`, `scenario-runs.ts`).
 *
 * Keyed by mode because the defaults are: `capacity` walks a level every
 * `stepDuration`, so its deadline is 300s rather than the 60s the others fall
 * back to. Its `concurrency` is the search ceiling, not a target: sent
 * explicitly, it is what `checkLoadCaps` judges against `maxConcurrency` (#2493).
 * Its other knobs (`sloMs`, `stepDuration`) stay the engine's. `iterations` has no duration: the mode never reads one.
 */
export const ENGINE_LOAD_DEFAULTS = {
	constant_concurrency: { concurrency: 100, durationSeconds: 60, ratePaced: true },
	constant_rps: { concurrency: 100, durationSeconds: 60, ratePaced: true },
	ramp_up: {
		concurrency: 100,
		startConcurrency: 1,
		durationSeconds: 60,
		rampUpDurationSeconds: 10,
	},
	iterations: { concurrency: 10, iterations: 1000 },
	capacity: { concurrency: 100, durationSeconds: 300 },
} as const satisfies Record<LoadMode, EngineLoadDefaults>;

/**
 * Defaults per mode, read as optional fields. Partial because an executor need
 * not run every mode: the scenario executor refuses two of the five.
 */
export type LoadDefaultsTable = Readonly<Partial<Record<LoadMode, EngineLoadDefaults>>>;

/**
 * The mode whose strategy the engine runs for these params, mirroring
 * `LoadStrategy::create` (`load_strategy.cpp`): an absent `mode` is the
 * engine's own `constant_rps` (`start_load_run` always sends one, so only a
 * direct caller of these guards meets that case), and an unrecognised mode is a
 * constant run, or an iterations run when it carries `iterations`. Keying on
 * the mode string alone would leave that last case a way past the cap.
 */
export function engineLoadMode(params: LoadRunParams): LoadMode {
	const mode = params.mode ?? "constant_rps";
	if (isLoadMode(mode)) return mode;
	return typeof params.iterations === "number" ? "iterations" : "constant_rps";
}

/**
 * Enforce the hard load caps (RPS / concurrency / duration / iterations).
 * Returns the first violation found, with a message naming the offending value
 * and the ceiling. Every field `start_load_run` forwards to the engine that can
 * grow a run is checked here - a forwarded field this function does not read is
 * a cap that cannot fire.
 */
export function checkLoadCaps(
	params: LoadRunParams,
	config: McpSafetyConfig,
	host: McpHost
): GuardResult {
	if (typeof params.targetRps === "number" && params.targetRps > config.maxRps) {
		return {
			ok: false,
			error: `targetRps ${params.targetRps} exceeds the MCP cap of ${config.maxRps}. Lower it, or ask the user to ${settingRemedy("maxRps", host)}.`,
		};
	}
	// `startConcurrency` rides the same ceiling as `concurrency`: `ramp_up` seeds
	// the run with it (`RampUpLoadStrategy`, `target_fn(0) = startConcurrency`),
	// so an uncapped start is an uncapped run however low the target is. For
	// `capacity` the same pair is what bounds the search - `concurrency` is the
	// ceiling it climbs toward rather than a target it holds - so capping both
	// is exactly what stops an adaptive run from outgrowing the cap.
	for (const field of ["concurrency", "startConcurrency"] as const) {
		const value = params[field];
		if (typeof value === "number" && value > config.maxConcurrency) {
			return {
				ok: false,
				error: `${field} ${value} exceeds the MCP cap of ${config.maxConcurrency} virtual users. Lower it, or ask the user to ${settingRemedy("maxConcurrency", host)}.`,
			};
		}
	}
	// A duration the engine cannot read now fails the run rather than quietly
	// becoming 60s, so say so here instead of starting a run that dies.
	for (const field of ["duration", "rampUpDuration", "stepDuration"] as const) {
		const value = params[field];
		if (value !== undefined && parseDurationGrammar(value) === null) {
			return {
				ok: false,
				error: `${field} ${JSON.stringify(value)} is not a duration. Use a non-negative number with an optional ms/s/m/h unit, e.g. "500ms", "30s", "5m", "2h".`,
			};
		}
	}
	// Past the grammar, `duration` still has a range rule `rampUpDuration` does
	// not: the engine 400s a zero-length run (`validate_run_config`) while a
	// zero ramp is an instant one it accepts (`ramp_target_concurrency` returns
	// the target for `ramp_ms <= 0`). So only this field goes through the
	// stricter parse, and a null here can only mean zero.
	const durationSeconds = parseDurationSeconds(params.duration);
	if (params.duration !== undefined && durationSeconds === null) {
		return {
			ok: false,
			error: `duration ${JSON.stringify(params.duration)} must be greater than zero - the engine refuses a run with no time to run in.`,
		};
	}
	if (durationSeconds !== null && durationSeconds > config.maxDurationSeconds) {
		return {
			ok: false,
			error: `duration ${params.duration} (${durationSeconds}s) exceeds the MCP cap of ${config.maxDurationSeconds}s. Shorten it, or ask the user to ${settingRemedy("maxDurationSeconds", host)}.`,
		};
	}
	if (engineLoadMode(params) === "iterations") {
		const iterations = params.iterations ?? ENGINE_LOAD_DEFAULTS.iterations.iterations;
		if (!Number.isFinite(iterations) || iterations <= 0) {
			return {
				ok: false,
				error: `iterations ${JSON.stringify(params.iterations)} must be a positive whole number of requests.`,
			};
		}
		if (iterations > config.maxIterations) {
			return {
				ok: false,
				error: `iterations ${iterations} exceeds the MCP cap of ${config.maxIterations}. An iterations run stops on request count rather than time, so the duration cap cannot bound it - lower iterations, use a duration-bounded mode, or ask the user to ${settingRemedy("maxIterations", host)}.`,
			};
		}
	}
	return OK;
}

/**
 * What a run keeps when `max_response_samples` is not sent
 * (`DEFAULT_MAX_RESPONSE_SAMPLES`, `constants.hpp`; `safety.test.ts` reads it).
 */
export const ENGINE_DEFAULT_MAX_RESPONSE_SAMPLES = 1000;

/**
 * Enforce the cap on the response bodies a run may keep. Judged like every
 * load cap, on the run the engine will start: an omitted `maxResponseSamples` is
 * the engine's default, so a cap below it refuses a run that stated nothing and
 * the message says why, rather than the cap silently not binding.
 */
export function checkSampleCap(
	maxResponseSamples: number | undefined,
	config: McpSafetyConfig,
	host: McpHost
): GuardResult {
	const samples = maxResponseSamples ?? ENGINE_DEFAULT_MAX_RESPONSE_SAMPLES;
	if (samples <= config.maxResponseSamples) return OK;
	const stated =
		maxResponseSamples === undefined
			? `maxResponseSamples ${samples} (the engine's default, as none was stated)`
			: `maxResponseSamples ${samples}`;
	return {
		ok: false,
		error: `${stated} exceeds the MCP cap of ${config.maxResponseSamples}. Each sample holds a full response body in memory. Lower it, or ask the user to ${settingRemedy("maxResponseSamples", host)}.`,
	};
}
