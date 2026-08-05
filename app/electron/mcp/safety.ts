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
 * cannot be parsed - which notably includes URLs still containing unresolved
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
	iterations?: number;
}

/**
 * Modes the engine recognises (`parse_load_test_type`, `vayu/types.hpp`).
 * Anything else falls through `LoadStrategy::create`, so the guard mirrors that
 * fallback rather than trusting the string it was given.
 */
const KNOWN_LOAD_MODES = new Set(["constant_rps", "constant_concurrency", "ramp_up", "iterations"]);

/**
 * What the engine runs when `duration` is absent - `duration_field_ms(config,
 * "duration", 60000)` in `load_strategy.cpp`. An omitted duration is therefore
 * not "no duration", and a cap below this one only binds if the field is sent.
 */
const ENGINE_DEFAULT_DURATION_SECONDS = 60;

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
	if (config.maxDurationSeconds >= ENGINE_DEFAULT_DURATION_SECONDS) return null;
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
	// so an uncapped start is an uncapped run however low the target is.
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
	for (const field of ["duration", "rampUpDuration"] as const) {
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
