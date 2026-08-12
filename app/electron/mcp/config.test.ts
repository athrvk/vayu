/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
	buildSafetyConfigFromEnv,
	DEFAULT_MCP_SAFETY_CONFIG,
	formatSafetyEnvNotices,
	MCP_CAP_CEILINGS,
	normalizeHost,
	resolveSafetyConfig,
	sanitizeSafetyInput,
	type McpCapKey,
} from "./config.js";
import { checkAllowlist, checkLoadCaps } from "./safety.js";
import { LOAD_TEST_CEILING_BOUNDS } from "@/constants/load-test";

describe("normalizeHost", () => {
	it("strips scheme, port, path, and query and lowercases", () => {
		expect(normalizeHost("https://API.Example.com:8080/v1?x=1")).toBe("api.example.com");
	});

	it("passes through a bare hostname", () => {
		expect(normalizeHost("api.example.com")).toBe("api.example.com");
	});

	it("handles scheme-less host with a path", () => {
		expect(normalizeHost("api.example.com/users")).toBe("api.example.com");
	});

	it("trims surrounding whitespace", () => {
		expect(normalizeHost("  localhost  ")).toBe("localhost");
	});

	it("returns empty string for empty input", () => {
		expect(normalizeHost("   ")).toBe("");
	});

	// Splitting the port off at the first colon reduced these to "" or "[", so no
	// stored entry could contain a colon and no IPv6 host could ever match.
	it.each(["::1", "[::1]", "[::1]:9876", "http://[::1]:8080", "[0:0:0:0:0:0:0:1]"])(
		"normalizes the IPv6 target %s to the canonical bracketed form",
		(raw) => {
			expect(normalizeHost(raw)).toBe("[::1]");
		}
	);

	it("canonicalizes a bare IPv6 address the way URL.hostname does", () => {
		expect(normalizeHost("2001:DB8::1")).toBe("[2001:db8::1]");
	});

	it.each(["[", "[]", "[::1]junk", ":::"])("drops the malformed bracket form %s", (raw) => {
		expect(normalizeHost(raw)).toBe("");
	});
});

describe("sanitizeSafetyInput", () => {
	it("normalizes and de-duplicates allowlist hosts", () => {
		const out = sanitizeSafetyInput({
			allowlist: ["https://api.example.com/x", "API.EXAMPLE.COM", "  ", "localhost:9876"],
		});
		expect(out.allowlist).toEqual(["api.example.com", "localhost"]);
	});

	it("keeps an IPv6 host through the sanitizer every allowlist edit passes", () => {
		const out = sanitizeSafetyInput({
			allowlist: ["::1", "[::1]:9876", "[", "localhost:9876"],
		});
		expect(out.allowlist).toEqual(["[::1]", "localhost"]);
	});

	it("drops non-string allowlist entries", () => {
		const out = sanitizeSafetyInput({
			allowlist: ["good.com", 42, null, undefined] as unknown as string[],
		});
		expect(out.allowlist).toEqual(["good.com"]);
	});

	it("floors positive caps and ignores non-positive / non-finite values", () => {
		expect(sanitizeSafetyInput({ maxRps: 100.9 }).maxRps).toBe(100);
		expect(sanitizeSafetyInput({ maxRps: 0 }).maxRps).toBeUndefined();
		expect(sanitizeSafetyInput({ maxConcurrency: -5 }).maxConcurrency).toBeUndefined();
		expect(
			sanitizeSafetyInput({ maxDurationSeconds: Number.NaN }).maxDurationSeconds
		).toBeUndefined();
		expect(sanitizeSafetyInput({ maxIterations: 5000.7 }).maxIterations).toBe(5000);
		expect(sanitizeSafetyInput({ maxIterations: 0 }).maxIterations).toBeUndefined();
	});

	/*
	 * A cap above its ceiling used to be stored verbatim, so Settings could hold
	 * a Max concurrency of 50,000 while the engine refuses anything over 10,000:
	 * the panel showed a guardrail that no run could ever reach, and the run it
	 * was meant to bound died on an engine 400 instead.
	 */
	it("holds each cap at its ceiling instead of storing a value no run can reach", () => {
		const keys = Object.keys(MCP_CAP_CEILINGS) as McpCapKey[];
		expect(keys.length).toBe(4);
		for (const key of keys) {
			const ceiling = MCP_CAP_CEILINGS[key];
			expect(sanitizeSafetyInput({ [key]: ceiling + 1 })[key]).toBe(ceiling);
			expect(sanitizeSafetyInput({ [key]: ceiling * 10 })[key]).toBe(ceiling);
			// The ceiling itself and everything under it are the user's to set.
			expect(sanitizeSafetyInput({ [key]: ceiling })[key]).toBe(ceiling);
			expect(sanitizeSafetyInput({ [key]: 7 })[key]).toBe(7);
		}
	});

	it("holds an over-ceiling cap read back from a hand-edited config file too", () => {
		// `loadPersistedSafety` re-sanitizes what it reads, so a file edited
		// while the app was closed cannot smuggle a cap past the ceiling.
		const resolved = resolveSafetyConfig(sanitizeSafetyInput({ maxConcurrency: 99_999 }));
		expect(resolved.maxConcurrency).toBe(MCP_CAP_CEILINGS.maxConcurrency);
	});

	/*
	 * Second copy of the same four numbers: the renderer's ceiling bounds and
	 * this sanitizer. `electron/` production code may not import `src/`, so the
	 * copy stays - this is the half of the chain that keeps it honest, the
	 * renderer-to-engine half living in
	 * `src/constants/load-test.engine-parity.test.ts`. The load dialog and an
	 * agent must not disagree about the largest run Vayu will start.
	 */
	it("mirrors the ceilings the load dialog itself will not exceed", () => {
		expect(MCP_CAP_CEILINGS).toEqual({
			maxRps: LOAD_TEST_CEILING_BOUNDS.rps.MAX,
			maxConcurrency: LOAD_TEST_CEILING_BOUNDS.concurrency.MAX,
			maxDurationSeconds: LOAD_TEST_CEILING_BOUNDS.durationSeconds.MAX,
			maxIterations: LOAD_TEST_CEILING_BOUNDS.iterations.MAX,
		});
	});

	it("keeps allowWrites only when it is a boolean", () => {
		expect(sanitizeSafetyInput({ allowWrites: true }).allowWrites).toBe(true);
		expect(
			sanitizeSafetyInput({ allowWrites: "yes" as unknown as boolean }).allowWrites
		).toBeUndefined();
	});

	it("keeps allowAll only when it is a boolean", () => {
		expect(sanitizeSafetyInput({ allowAll: true }).allowAll).toBe(true);
		expect(
			sanitizeSafetyInput({ allowAll: "yes" as unknown as boolean }).allowAll
		).toBeUndefined();
	});

	it("normalizes disabledTools: trims, drops non-strings, de-dupes", () => {
		const out = sanitizeSafetyInput({
			disabledTools: [
				"run_request",
				" run_request ",
				"",
				5,
				"stop_run",
			] as unknown as string[],
		});
		expect(out.disabledTools).toEqual(["run_request", "stop_run"]);
	});

	it("ignores unknown fields", () => {
		const out = sanitizeSafetyInput({ nope: 1 } as unknown as Record<string, never>);
		expect(out).toEqual({});
	});

	it("round-trips cleanly through resolveSafetyConfig onto defaults", () => {
		const resolved = resolveSafetyConfig(sanitizeSafetyInput({ allowlist: ["a.com"] }));
		expect(resolved).toEqual({ ...DEFAULT_MCP_SAFETY_CONFIG, allowlist: ["a.com"] });
	});
});

/*
 * The seam the stdio CLI (`cli.ts`) builds its config from. These assert the
 * guards downstream of it - a cap that still refuses, a host that still matches
 * - because a `NaN` cap is not visibly wrong in the config object; it is only
 * wrong at the `x > NaN` comparison inside `checkLoadCaps`.
 */
describe("buildSafetyConfigFromEnv", () => {
	it("falls back to the default cap when a cap variable is not a number", () => {
		const { config } = buildSafetyConfigFromEnv({ VAYU_MCP_MAX_RPS: "1,000" });

		expect(config.maxRps).toBe(DEFAULT_MCP_SAFETY_CONFIG.maxRps);
		expect(Number.isNaN(config.maxRps)).toBe(false);
		// The cap has to still fire - an unsanitized NaN would let this through.
		expect(checkLoadCaps({ targetRps: 50000 }, config).ok).toBe(false);
	});

	it("falls back for every cap variable, not just RPS", () => {
		const { config, ignored } = buildSafetyConfigFromEnv({
			VAYU_MCP_MAX_CONCURRENCY: "500rps",
			VAYU_MCP_MAX_DURATION_SECONDS: "unset",
			VAYU_MCP_MAX_ITERATIONS: "1e6 requests",
		});

		expect(config.maxConcurrency).toBe(DEFAULT_MCP_SAFETY_CONFIG.maxConcurrency);
		expect(config.maxDurationSeconds).toBe(DEFAULT_MCP_SAFETY_CONFIG.maxDurationSeconds);
		expect(config.maxIterations).toBe(DEFAULT_MCP_SAFETY_CONFIG.maxIterations);
		expect(checkLoadCaps({ concurrency: 10000 }, config).ok).toBe(false);
		expect(checkLoadCaps({ duration: "24h" }, config).ok).toBe(false);
		// The iterations cap is the one a malformed value must not silently
		// disable: that mode stops on a request count, so no other cap bounds it.
		expect(checkLoadCaps({ mode: "iterations", iterations: 1_000_000 }, config).ok).toBe(false);
		expect(ignored.map((i) => i.variable)).toContain("VAYU_MCP_MAX_ITERATIONS");
	});

	it("reads the iterations cap from the environment", () => {
		const { config, ignored } = buildSafetyConfigFromEnv({ VAYU_MCP_MAX_ITERATIONS: "250" });

		expect(ignored).toEqual([]);
		expect(config.maxIterations).toBe(250);
		expect(checkLoadCaps({ mode: "iterations", iterations: 251 }, config).ok).toBe(false);
		expect(checkLoadCaps({ mode: "iterations", iterations: 250 }, config).ok).toBe(true);
	});

	it("holds an over-ceiling cap the same way the Settings path does", () => {
		const { config, ignored, clamped } = buildSafetyConfigFromEnv({
			VAYU_MCP_MAX_CONCURRENCY: "50000",
		});

		expect(config.maxConcurrency).toBe(MCP_CAP_CEILINGS.maxConcurrency);
		// Held, not thrown away: `ignored` is for values that fell back to a
		// default, and this one is in force at the ceiling - so it is reported
		// through the other channel, with the value that actually applies.
		expect(ignored).toEqual([]);
		expect(clamped).toEqual([
			{
				variable: "VAYU_MCP_MAX_CONCURRENCY",
				value: "50000",
				applied: MCP_CAP_CEILINGS.maxConcurrency,
			},
		]);
		expect(checkLoadCaps({ concurrency: 10_001 }, config).ok).toBe(false);
	});

	it("reports a clamped cap for every cap variable, never for an in-range one", () => {
		const { clamped } = buildSafetyConfigFromEnv({
			VAYU_MCP_MAX_RPS: "2000000",
			VAYU_MCP_MAX_CONCURRENCY: "50000",
			VAYU_MCP_MAX_DURATION_SECONDS: "300",
			VAYU_MCP_MAX_ITERATIONS: "999000000",
		});

		expect(clamped.map((c) => c.variable)).toEqual([
			"VAYU_MCP_MAX_RPS",
			"VAYU_MCP_MAX_CONCURRENCY",
			"VAYU_MCP_MAX_ITERATIONS",
		]);
		expect(clamped.map((c) => c.applied)).toEqual([
			MCP_CAP_CEILINGS.maxRps,
			MCP_CAP_CEILINGS.maxConcurrency,
			MCP_CAP_CEILINGS.maxIterations,
		]);
	});

	it("keeps the clamped and ignored channels from blurring", () => {
		const { ignored, clamped } = buildSafetyConfigFromEnv({
			VAYU_MCP_MAX_RPS: "1,000",
			VAYU_MCP_MAX_CONCURRENCY: "50000",
		});

		// A malformed variable fell back and is only `ignored`; a clamped one is
		// in force and is only `clamped`. An operator reading one channel must
		// not be told the other thing happened.
		expect(ignored.map((i) => i.variable)).toEqual(["VAYU_MCP_MAX_RPS"]);
		expect(clamped.map((c) => c.variable)).toEqual(["VAYU_MCP_MAX_CONCURRENCY"]);
	});

	it("does not call a floored fractional cap clamped", () => {
		const { config, clamped } = buildSafetyConfigFromEnv({
			// Floored to 999, which is not a ceiling being applied - saying "above
			// the maximum of 1000000" here would name a limit it never came near.
			VAYU_MCP_MAX_RPS: "999.7",
			// Fractional too, but over the ceiling once floored, so this one is
			// reported and the ceiling is what applies.
			VAYU_MCP_MAX_ITERATIONS: "100000001.5",
		});

		expect(config.maxRps).toBe(999);
		expect(config.maxIterations).toBe(MCP_CAP_CEILINGS.maxIterations);
		expect(clamped.map((c) => c.variable)).toEqual(["VAYU_MCP_MAX_ITERATIONS"]);
	});

	it("rejects a non-positive cap the same way the Settings path does", () => {
		const { config } = buildSafetyConfigFromEnv({ VAYU_MCP_MAX_RPS: "0" });

		expect(config.maxRps).toBe(DEFAULT_MCP_SAFETY_CONFIG.maxRps);
	});

	it("normalizes allowlist entries carrying a scheme or a port", () => {
		const { config } = buildSafetyConfigFromEnv({
			VAYU_MCP_ALLOWLIST: "https://api.example.com, localhost:9876 , API.EXAMPLE.COM",
		});

		expect(config.allowlist).toEqual(["api.example.com", "localhost"]);
		expect(checkAllowlist("https://api.example.com/users", config).ok).toBe(true);
		expect(checkAllowlist("http://localhost:9876/health", config).ok).toBe(true);
	});

	it("names each ignored variable, its raw value, and the default that applied", () => {
		const { ignored } = buildSafetyConfigFromEnv({
			VAYU_MCP_MAX_RPS: "1,000",
			VAYU_MCP_MAX_CONCURRENCY: "200",
		});

		expect(ignored).toEqual([
			{
				variable: "VAYU_MCP_MAX_RPS",
				value: "1,000",
				fallback: DEFAULT_MCP_SAFETY_CONFIG.maxRps,
			},
		]);
	});

	it("reports nothing when every variable is well-formed", () => {
		const { config, ignored, clamped } = buildSafetyConfigFromEnv({
			VAYU_MCP_ALLOWLIST: "api.example.com",
			VAYU_MCP_MAX_RPS: "50",
			VAYU_MCP_MAX_CONCURRENCY: "10",
			VAYU_MCP_MAX_DURATION_SECONDS: "30",
			VAYU_MCP_MAX_ITERATIONS: "500",
			VAYU_MCP_ALLOW_ALL: "true",
			VAYU_MCP_ALLOW_WRITES: "true",
			VAYU_MCP_DISABLED_TOOLS: "run_request, stop_run",
		});

		expect(ignored).toEqual([]);
		expect(clamped).toEqual([]);
		// Exhaustive on purpose: a field added to McpSafetyConfig without an env
		// var lands here as an unexpected key. That is how the missing
		// VAYU_MCP_MAX_ITERATIONS was caught.
		expect(config).toEqual({
			allowlist: ["api.example.com"],
			allowAll: true,
			maxRps: 50,
			maxConcurrency: 10,
			maxDurationSeconds: 30,
			maxIterations: 500,
			allowWrites: true,
			disabledTools: ["run_request", "stop_run"],
		});
	});

	it("returns the safe defaults for an empty environment", () => {
		const { config, ignored, clamped } = buildSafetyConfigFromEnv({});

		expect(config).toEqual(DEFAULT_MCP_SAFETY_CONFIG);
		expect(ignored).toEqual([]);
		expect(clamped).toEqual([]);
	});

	it('leaves the opt-in booleans off for any value other than "true"', () => {
		const { config } = buildSafetyConfigFromEnv({
			VAYU_MCP_ALLOW_ALL: "1",
			VAYU_MCP_ALLOW_WRITES: "yes",
		});

		expect(config.allowAll).toBe(false);
		expect(config.allowWrites).toBe(false);
	});
});

/*
 * What the stdio operator actually sees. A channel nothing prints is the
 * "written but never read" defect, so these assert the lines, and the last one
 * asserts `cli.ts` is what emits them.
 */
describe("formatSafetyEnvNotices", () => {
	it("names a clamped cap, its raw value, and the value in force", () => {
		const notices = formatSafetyEnvNotices(
			buildSafetyConfigFromEnv({ VAYU_MCP_MAX_CONCURRENCY: "50000" })
		);

		expect(notices).toEqual([
			'[vayu-mcp] VAYU_MCP_MAX_CONCURRENCY="50000" is above the maximum of 10000; running with 10000',
		]);
	});

	it("prints both channels, ignored first, and keeps their wording distinct", () => {
		const notices = formatSafetyEnvNotices(
			buildSafetyConfigFromEnv({
				VAYU_MCP_MAX_RPS: "1,000",
				VAYU_MCP_MAX_CONCURRENCY: "50000",
			})
		);

		expect(notices).toEqual([
			'[vayu-mcp] ignoring malformed VAYU_MCP_MAX_RPS="1,000" (using default 1000)',
			'[vayu-mcp] VAYU_MCP_MAX_CONCURRENCY="50000" is above the maximum of 10000; running with 10000',
		]);
	});

	it("says nothing when the environment survived intact", () => {
		expect(
			formatSafetyEnvNotices(buildSafetyConfigFromEnv({ VAYU_MCP_MAX_RPS: "50" }))
		).toEqual([]);
	});

	it("is what the CLI prints, so neither channel can go unread", () => {
		const source = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");

		// Guard the guard: an empty read would pass every assertion below.
		expect(source.length).toBeGreaterThan(0);
		expect(source).toContain("formatSafetyEnvNotices");
		expect(source).toContain("console.error(notice)");
	});
});
