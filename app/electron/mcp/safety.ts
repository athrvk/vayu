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
function isPrivateHost(host: string): boolean {
	if (host === "localhost" || host.endsWith(".localhost")) return true;

	if (host.startsWith("[") && host.endsWith("]")) {
		// `::ffff:127.0.0.1` is a v4 address wearing a v6 spelling, so it is
		// classified as the v4 one rather than falling through as "not private".
		const address = host.slice(1, -1).replace(/^::ffff:/, "");
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
 * would make the capability unreachable in the case it was built for. The
 * engine draws the same line for the same reason (`read_monitor_block`,
 * `engine/src/core/monitor.cpp`).
 *
 * A public monitor host is a request to some third party at one GET per scrape
 * for the life of the run, which is exactly what the allowlist is for, so it
 * goes through the same check the target URL does.
 */
export function checkMonitorHost(url: string, config: McpSafetyConfig): GuardResult {
	const host = extractHost(url);
	if (!host) {
		return {
			ok: false,
			error: "Could not determine the host of `monitor.url` (it may be empty or contain unresolved {{variables}}). Resolve it before retrying.",
		};
	}
	if (isPrivateHost(host)) return OK;
	const gate = checkAllowlist(url, config);
	if (gate.ok) return OK;
	return {
		ok: false,
		error: `The monitor endpoint is a second host this run would contact, once per scrape: ${gate.error} (A loopback or private-network monitor URL needs no allowlist entry.)`,
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
 * Modes the engine recognises (`parse_load_test_type`, `vayu/types.hpp`).
 * Anything else falls through `LoadStrategy::create`, so the guard mirrors that
 * fallback rather than trusting the string it was given.
 */
const KNOWN_LOAD_MODES = new Set([
	"constant_rps",
	"constant_concurrency",
	"ramp_up",
	"iterations",
	"capacity",
]);

/**
 * What the engine runs when `duration` is absent, **per mode**.
 *
 * An omitted duration is not "no duration": each strategy passes its own
 * fallback to `duration_field_ms`, so a cap only binds when the field is sent
 * *or* when the cap is under the default the engine would otherwise use.
 *
 * This was a single number, on the assumption that every mode falls back to
 * 60s. `capacity` does not - it walks a level every `stepDuration`, so its
 * `constants::capacity::DEADLINE_MS` is 300s - and the assumption became a
 * hole: with the cap set to 120s and an agent omitting `duration`,
 * `checkLoadCaps` had nothing to check and this function returned null because
 * 120 >= 60, so the search ran for 300s against a 120s cap. Keyed by mode, the
 * guard now models what the engine actually does rather than one mode's version
 * of it, and `safety.test.ts` reads `constants.hpp` to keep the numbers in step.
 */
const ENGINE_DEFAULT_DURATION_SECONDS: Readonly<Record<string, number>> = {
	capacity: 300,
};

/** The fallback for every mode that has no entry of its own. */
const ENGINE_FALLBACK_DURATION_SECONDS = 60;

/** What the engine would run for, in seconds, if `duration` were omitted. */
function engineDefaultDurationSeconds(mode: string): number {
	return ENGINE_DEFAULT_DURATION_SECONDS[mode] ?? ENGINE_FALLBACK_DURATION_SECONDS;
}

/** What the engine runs when `iterations` is absent (`IterationsLoadStrategy`). */
const ENGINE_DEFAULT_ITERATIONS = 1000;

/**
 * Whether the engine will run these params as an iterations run - the one mode
 * that stops on a request count and never reads `duration`, so no duration cap
 * can bound it. Mirrors `LoadStrategy::create` (`load_strategy.cpp`): an
 * unrecognised mode carrying an `iterations` field still lands on that
 * strategy, so keying on the mode string alone leaves a way past the cap.
 */
function isIterationsRun(params: LoadRunParams): boolean {
	// The engine's own default for an absent `mode`, which is a duration mode.
	const mode = params.mode ?? "constant_rps";
	if (mode === "iterations") return true;
	if (KNOWN_LOAD_MODES.has(mode)) return false;
	return typeof params.iterations === "number";
}

/**
 * The `duration` to send when the caller omitted one, or null when the engine
 * default is already inside the cap and the payload needs no field. Iterations
 * runs get null: `duration` is not read in that mode, so injecting it would be
 * a value written and never read.
 */
export function defaultDurationUnderCap(
	params: LoadRunParams,
	config: McpSafetyConfig
): string | null {
	if (params.duration !== undefined) return null;
	if (isIterationsRun(params)) return null;
	// The engine's own default for an absent `mode` is a duration mode, and the
	// same string `isIterationsRun` reads - the two must agree about which run
	// this is or the cap lands on the wrong strategy.
	const mode = params.mode ?? "constant_rps";
	if (config.maxDurationSeconds >= engineDefaultDurationSeconds(mode)) return null;
	return `${config.maxDurationSeconds}s`;
}

/**
 * Enforce the hard load caps (RPS / concurrency / duration / iterations).
 * Returns the first violation found, with a message naming the offending value
 * and the ceiling. Every field `start_load_run` forwards to the engine that can
 * grow a run is checked here - a forwarded field this function does not read is
 * a cap that cannot fire.
 */
export function checkLoadCaps(params: LoadRunParams, config: McpSafetyConfig): GuardResult {
	if (typeof params.targetRps === "number" && params.targetRps > config.maxRps) {
		return {
			ok: false,
			error: `targetRps ${params.targetRps} exceeds the MCP cap of ${config.maxRps}. Lower it or raise the cap in Settings.`,
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
				error: `${field} ${value} exceeds the MCP cap of ${config.maxConcurrency}. Lower it or raise the cap in Settings.`,
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
			error: `duration ${params.duration} (${durationSeconds}s) exceeds the MCP cap of ${config.maxDurationSeconds}s. Shorten it or raise the cap in Settings.`,
		};
	}
	if (isIterationsRun(params)) {
		const iterations = params.iterations ?? ENGINE_DEFAULT_ITERATIONS;
		if (!Number.isFinite(iterations) || iterations <= 0) {
			return {
				ok: false,
				error: `iterations ${JSON.stringify(params.iterations)} must be a positive whole number of requests.`,
			};
		}
		if (iterations > config.maxIterations) {
			return {
				ok: false,
				error: `iterations ${iterations} exceeds the MCP cap of ${config.maxIterations}. An iterations run stops on request count rather than time, so the duration cap cannot bound it - lower iterations, use a duration-bounded mode, or raise the cap in Settings.`,
			};
		}
	}
	return OK;
}
