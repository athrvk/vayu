/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test } from "vitest";
import {
	extractHost,
	checkAllowlist,
	parseDurationSeconds,
	checkLoadCaps,
	defaultDurationUnderCap,
} from "./safety.js";
import { DEFAULT_MCP_SAFETY_CONFIG, resolveSafetyConfig } from "./config.js";

describe("extractHost", () => {
	test("parses hostname from a full URL, lowercased", () => {
		expect(extractHost("https://API.Example.com/users")).toBe("api.example.com");
	});
	test("handles scheme-less input", () => {
		expect(extractHost("api.example.com/users")).toBe("api.example.com");
	});
	test("returns null for unresolved template variables", () => {
		expect(extractHost("{{baseUrl}}/users")).toBeNull();
	});
	test("returns null for empty input", () => {
		expect(extractHost("")).toBeNull();
	});
});

describe("checkAllowlist", () => {
	test("denies everything when the allowlist is empty (safe default)", () => {
		const res = checkAllowlist("https://api.example.com/x", DEFAULT_MCP_SAFETY_CONFIG);
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/allowlist is empty/i);
	});
	test("allows a host that is on the list (case-insensitive)", () => {
		const config = resolveSafetyConfig({ allowlist: ["api.example.com"] });
		expect(checkAllowlist("https://API.example.com/x", config).ok).toBe(true);
	});
	test("denies a host that is not on the list", () => {
		const config = resolveSafetyConfig({ allowlist: ["api.example.com"] });
		const res = checkAllowlist("https://evil.test/x", config);
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/not on Vayu's MCP allowlist/i);
	});
	test("denies when the host cannot be determined", () => {
		const config = resolveSafetyConfig({ allowlist: ["api.example.com"] });
		expect(checkAllowlist("{{baseUrl}}/x", config).ok).toBe(false);
	});
	test("allowAll bypasses the allowlist for any resolvable host", () => {
		const config = resolveSafetyConfig({ allowAll: true });
		expect(checkAllowlist("https://anything.example.org/x", config).ok).toBe(true);
		// even with an empty allowlist
		expect(config.allowlist).toEqual([]);
	});
	test("allowAll still rejects an unresolvable host (unresolved variables)", () => {
		const config = resolveSafetyConfig({ allowAll: true });
		expect(checkAllowlist("{{baseUrl}}/x", config).ok).toBe(false);
	});
});

describe("parseDurationSeconds", () => {
	test.each([
		["60s", 60],
		["5m", 300],
		["1h", 3600],
		["500ms", 0.5],
		["30", 30],
		[45, 45],
	])("parses %s", (input, expected) => {
		expect(parseDurationSeconds(input)).toBe(expected);
	});
	test("returns null for garbage", () => {
		expect(parseDurationSeconds("soon")).toBeNull();
		expect(parseDurationSeconds(undefined)).toBeNull();
	});
	// It reads a run's `duration`, which the engine requires to be positive
	// (`validate_run_config`), so zero is not a duration it can return.
	test("rejects zero, which the engine 400s", () => {
		expect(parseDurationSeconds("0")).toBeNull();
		expect(parseDurationSeconds("0s")).toBeNull();
		expect(parseDurationSeconds("0ms")).toBeNull();
		expect(parseDurationSeconds(0)).toBeNull();
	});
});

describe("checkLoadCaps", () => {
	const config = resolveSafetyConfig({
		maxRps: 1000,
		maxConcurrency: 200,
		maxDurationSeconds: 300,
	});

	test("passes within caps", () => {
		expect(
			checkLoadCaps({ targetRps: 500, concurrency: 100, duration: "60s" }, config).ok
		).toBe(true);
	});
	test("rejects excessive RPS", () => {
		const res = checkLoadCaps({ targetRps: 5000 }, config);
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/targetRps 5000 exceeds/);
	});
	test("rejects excessive concurrency", () => {
		expect(checkLoadCaps({ concurrency: 5000 }, config).ok).toBe(false);
	});
	test("rejects excessive duration", () => {
		const res = checkLoadCaps({ duration: "10m" }, config);
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/exceeds the MCP cap of 300s/);
	});

	// The engine fails a run whose duration it cannot read, so the tool says so
	// up front rather than starting a run that dies. An absent field is still
	// fine - it means "use the engine default".
	test("rejects a duration the engine cannot read", () => {
		const res = checkLoadCaps({ duration: "soon" }, config);
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/is not a duration/);
		expect(res.error).toMatch(/ms\/s\/m\/h/);
	});
	test("rejects an unreadable rampUpDuration", () => {
		expect(checkLoadCaps({ rampUpDuration: "a while" }, config).ok).toBe(false);
	});
	test("accepts a readable rampUpDuration and an absent duration", () => {
		expect(checkLoadCaps({ rampUpDuration: "500ms" }, config).ok).toBe(true);
		expect(checkLoadCaps({ concurrency: 10 }, config).ok).toBe(true);
	});

	// A ramp is seeded with `startConcurrency` before its first duration check,
	// so a cap that reads only `concurrency` bounds the value the run ends at
	// and not the one it starts with.
	test("rejects a startConcurrency above the concurrency cap", () => {
		const res = checkLoadCaps(
			{ mode: "ramp_up", concurrency: 10, startConcurrency: 5000 },
			config
		);
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/startConcurrency 5000 exceeds the MCP cap of 200/);
	});
	test("accepts a startConcurrency at the cap", () => {
		expect(
			checkLoadCaps({ mode: "ramp_up", concurrency: 200, startConcurrency: 200 }, config).ok
		).toBe(true);
	});

	// An iterations run stops on a request count and never reads `duration`, so
	// `maxDurationSeconds` cannot bound it and `maxIterations` is what does.
	test("rejects an iterations run above the iterations cap", () => {
		const res = checkLoadCaps({ mode: "iterations", iterations: 1_000_000_000 }, config);
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/iterations 1000000000 exceeds the MCP cap of 10000/);
	});
	test("accepts an iterations run at the cap", () => {
		expect(checkLoadCaps({ mode: "iterations", iterations: 10_000 }, config).ok).toBe(true);
	});
	test("compares an omitted count against the engine's own default of 1000", () => {
		// An absent `iterations` is not "no iterations" - the engine runs 1000 -
		// so a cap under that has to refuse the run rather than wave it through.
		const tight = resolveSafetyConfig({ maxIterations: 500 });
		const res = checkLoadCaps({ mode: "iterations" }, tight);
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/iterations 1000 exceeds the MCP cap of 500/);
		expect(checkLoadCaps({ mode: "iterations" }, config).ok).toBe(true);
	});
	test("rejects a non-positive iterations count", () => {
		const res = checkLoadCaps({ mode: "iterations", iterations: -1 }, config);
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/must be a positive whole number/);
	});
	test("an unrecognised mode carrying iterations is still bounded", () => {
		// `LoadStrategy::create` falls through to the iterations strategy for a
		// mode it cannot parse when the config has an `iterations` field, so a
		// guard keying on the mode string alone would wave this past.
		const res = checkLoadCaps({ mode: "burst", iterations: 1_000_000_000 }, config);
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/exceeds the MCP cap of 10000/);
	});
	test("a duration-mode run is not held to the iterations cap", () => {
		expect(
			checkLoadCaps(
				{ mode: "constant_rps", iterations: 1_000_000_000, duration: "30s" },
				config
			).ok
		).toBe(true);
	});

	// The engine 400s a zero-length run, so the tool names the field instead of
	// starting a run that dies on arrival.
	test("rejects a zero duration", () => {
		const res = checkLoadCaps({ duration: "0s" }, config);
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/must be greater than zero/);
	});
	test("still accepts a zero rampUpDuration (an instant ramp the engine allows)", () => {
		expect(
			checkLoadCaps({ mode: "ramp_up", rampUpDuration: "0s", duration: "30s" }, config).ok
		).toBe(true);
	});
});

describe("defaultDurationUnderCap", () => {
	test("supplies the cap when the run would otherwise take the engine's 60s default", () => {
		const config = resolveSafetyConfig({ maxDurationSeconds: 30 });
		expect(defaultDurationUnderCap({ mode: "constant_concurrency" }, config)).toBe("30s");
	});
	test("supplies nothing when the engine default is already inside the cap", () => {
		const config = resolveSafetyConfig({ maxDurationSeconds: 300 });
		expect(defaultDurationUnderCap({ mode: "constant_concurrency" }, config)).toBeNull();
	});
	test("supplies nothing when the caller gave a duration", () => {
		const config = resolveSafetyConfig({ maxDurationSeconds: 30 });
		expect(defaultDurationUnderCap({ duration: "10s" }, config)).toBeNull();
	});
	test("supplies nothing for an iterations run, which never reads duration", () => {
		const config = resolveSafetyConfig({ maxDurationSeconds: 30 });
		expect(defaultDurationUnderCap({ mode: "iterations", iterations: 10 }, config)).toBeNull();
	});
});
