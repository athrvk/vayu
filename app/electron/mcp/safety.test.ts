/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import {
	extractHost,
	checkAllowlist,
	checkMonitorHost,
	parseDurationSeconds,
	checkLoadCaps,
	ENGINE_LOAD_DEFAULTS,
	type EngineLoadDefaults,
	type LoadMode,
	type LoadRunParams,
} from "./safety.js";
import { resolveLoadShape } from "./tools/compose.js";
import { SCENARIO_LOAD_DEFAULTS } from "./tools/scenario-runs.js";
import { DEFAULT_MCP_SAFETY_CONFIG, normalizeHost, resolveSafetyConfig } from "./config.js";

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
	/**
	 * Where the template sits decides whether the host is knowable (issue #601).
	 *
	 * A `{{data.id}}` in the path is not waiting on a client to resolve it - it
	 * survives composition by design so the engine can bind a data row against
	 * it - and no value substituted after the authority can move the request to
	 * another server. Refusing those made `run_request`'s data row unusable in
	 * the position it is most often written.
	 *
	 * The authority cases below are the ones that still have to be refused, and
	 * are why this is positional rather than "ignore braces": a template in the
	 * hostname, the port or the userinfo names a target nothing here can know.
	 */
	test.each([
		["https://api.example.com/users/{{data.id}}", "api.example.com"],
		["https://api.example.com/users?id={{data.id}}", "api.example.com"],
		["https://api.example.com/u#{{data.frag}}", "api.example.com"],
		["api.example.com:8080/{{data.id}}", "api.example.com"],
	])("reads the host of %s, whose template is past the authority", (url, host) => {
		expect(extractHost(url)).toBe(host);
	});
	test.each([
		"https://{{host}}/users",
		"https://api.{{env}}.example.com/users",
		"https://api.example.com:{{port}}/users",
		"https://{{user}}:pw@api.example.com/users",
		"{{baseUrl}}",
	])("keeps %s unresolvable - the template is in the authority", (url) => {
		expect(extractHost(url)).toBeNull();
	});
	test("returns null for empty input", () => {
		expect(extractHost("")).toBeNull();
	});
	// These parse *successfully* with the host taken for a scheme and an empty
	// hostname, so the scheme-less retry only runs if emptiness triggers it too.
	test.each([
		["localhost:3000/api", "localhost"],
		["api.example.com:8080/x", "api.example.com"],
		["localhost:3000", "localhost"],
		["localhost:3000//api", "localhost"],
	])("handles scheme-less %s (host:port)", (url, host) => {
		expect(extractHost(url)).toBe(host);
	});
	test("keeps a genuinely host-less URL unresolvable rather than inventing one", () => {
		// The empty hostname here is the URL's own answer, not a misparse - the
		// scheme-less retry would turn it into the host "file".
		expect(extractHost("file:///etc/passwd")).toBeNull();
	});
	test("returns an IPv6 host in the bracketed form the allowlist stores", () => {
		expect(extractHost("http://[::1]:8080/x")).toBe("[::1]");
	});
});

describe("checkAllowlist", () => {
	test("denies everything when the allowlist is empty (safe default)", () => {
		const res = checkAllowlist("https://api.example.com/x", DEFAULT_MCP_SAFETY_CONFIG, "app");
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/allowlist is empty/i);
	});
	test("allows a host that is on the list (case-insensitive)", () => {
		const config = resolveSafetyConfig({ allowlist: ["api.example.com"] });
		expect(checkAllowlist("https://API.example.com/x", config, "app").ok).toBe(true);
	});
	test("denies a host that is not on the list", () => {
		const config = resolveSafetyConfig({ allowlist: ["api.example.com"] });
		const res = checkAllowlist("https://evil.test/x", config, "app");
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/not on the MCP allowlist/i);
	});
	test("allows a scheme-less host:port URL whose host is on the list", () => {
		// The refusal this replaces named unresolved {{variables}}, sending the
		// user hunting a resolution bug in a URL that resolved fine.
		const config = resolveSafetyConfig({ allowlist: ["localhost"] });
		expect(checkAllowlist("localhost:3000/api/users", config, "app").ok).toBe(true);
	});
	test("matches an allowlisted IPv6 literal against its target", () => {
		const config = resolveSafetyConfig({ allowlist: [normalizeHost("::1")] });
		expect(checkAllowlist("http://[::1]:9876/x", config, "app").ok).toBe(true);
	});
	test("denies when the host cannot be determined", () => {
		const config = resolveSafetyConfig({ allowlist: ["api.example.com"] });
		expect(checkAllowlist("{{baseUrl}}/x", config, "app").ok).toBe(false);
	});
	test("allowAll bypasses the allowlist for any resolvable host", () => {
		const config = resolveSafetyConfig({ allowAll: true });
		expect(checkAllowlist("https://anything.example.org/x", config, "app").ok).toBe(true);
		// even with an empty allowlist
		expect(config.allowlist).toEqual([]);
	});
	test("allowAll still rejects an unresolvable host (unresolved variables)", () => {
		const config = resolveSafetyConfig({ allowAll: true });
		expect(checkAllowlist("{{baseUrl}}/x", config, "app").ok).toBe(false);
	});
});

describe("checkMonitorHost", () => {
	// The decision this pins: a run's monitor endpoint is a *second* host, and it
	// is exempt from the allowlist only while it names the user's own network.
	// The feature exists to scrape the target's own localhost:9100, so requiring
	// an entry for that would make it unreachable in its own case; a public
	// monitor host is third-party traffic and gets the check the target gets.
	const empty = DEFAULT_MCP_SAFETY_CONFIG;

	test.each([
		"http://localhost:9100/metrics",
		"http://127.0.0.1:9100/metrics",
		"http://127.99.1.2:9100/metrics",
		"http://[::1]:9100/metrics",
		"http://10.0.3.4:9100/metrics",
		"http://172.16.0.9:9100/metrics",
		"http://172.31.255.1:9100/metrics",
		"http://192.168.1.50:9100/metrics",
		"http://169.254.10.1:9100/metrics",
		"http://[fd00::1]:9100/metrics",
		"http://[fe80::1]:9100/metrics",
		// WHATWG URL normalises the alternate IPv4 spellings, so the guard reads
		// 127.0.0.1 here rather than a string it would not recognise.
		"http://2130706433:9100/metrics",
	])("exempts the private/loopback endpoint %s from an empty allowlist", (url) => {
		expect(checkMonitorHost(url, empty, "app").ok).toBe(true);
	});

	test.each([
		"http://172.15.0.1:9100/metrics", // just below the RFC1918 block
		"http://172.32.0.1:9100/metrics", // just above it
		"http://192.169.1.1:9100/metrics",
		"http://11.0.0.1:9100/metrics",
		"http://[2001:db8::1]:9100/metrics",
		"https://metrics.example.com/metrics",
		// A name that may well resolve to a private address: the guard is textual,
		// like the allowlist itself, so this needs an entry rather than a lookup.
		"http://prometheus.internal/metrics",
	])("requires an allowlist entry for the public endpoint %s", (url) => {
		const res = checkMonitorHost(url, empty, "app");
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/monitor endpoint is a second host/i);
	});

	test("accepts a public monitor host that is on the allowlist", () => {
		const config = resolveSafetyConfig({ allowlist: ["metrics.example.com"] });
		expect(checkMonitorHost("https://metrics.example.com/m", config, "app").ok).toBe(true);
	});

	test("refuses a monitor URL whose host cannot be determined", () => {
		const config = resolveSafetyConfig({ allowlist: ["metrics.example.com"] });
		const res = checkMonitorHost("{{vitalsUrl}}/metrics", config, "app");
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/monitor\.url/i);
	});

	test("allowAll covers the monitor host too", () => {
		const config = resolveSafetyConfig({ allowAll: true });
		expect(checkMonitorHost("https://metrics.example.com/m", config, "app").ok).toBe(true);
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
			checkLoadCaps({ targetRps: 500, concurrency: 100, duration: "60s" }, config, "app").ok
		).toBe(true);
	});
	test("rejects excessive RPS", () => {
		const res = checkLoadCaps({ targetRps: 5000 }, config, "app");
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/targetRps 5000 exceeds/);
	});
	test("rejects excessive concurrency", () => {
		expect(checkLoadCaps({ concurrency: 5000 }, config, "app").ok).toBe(false);
	});
	test("rejects excessive duration", () => {
		const res = checkLoadCaps({ duration: "10m" }, config, "app");
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/exceeds the MCP cap of 300s/);
	});

	// The engine fails a run whose duration it cannot read, so the tool says so
	// up front rather than starting a run that dies. An absent field is still
	// fine - it means "use the engine default".
	test("rejects a duration the engine cannot read", () => {
		const res = checkLoadCaps({ duration: "soon" }, config, "app");
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/is not a duration/);
		expect(res.error).toMatch(/ms\/s\/m\/h/);
	});
	test("rejects an unreadable rampUpDuration", () => {
		expect(checkLoadCaps({ rampUpDuration: "a while" }, config, "app").ok).toBe(false);
	});
	test("accepts a readable rampUpDuration and an absent duration", () => {
		expect(checkLoadCaps({ rampUpDuration: "500ms" }, config, "app").ok).toBe(true);
		expect(checkLoadCaps({ concurrency: 10 }, config, "app").ok).toBe(true);
	});

	// A ramp is seeded with `startConcurrency` before its first duration check,
	// so a cap that reads only `concurrency` bounds the value the run ends at
	// and not the one it starts with.
	test("rejects a startConcurrency above the concurrency cap", () => {
		const res = checkLoadCaps(
			{ mode: "ramp_up", concurrency: 10, startConcurrency: 5000 },
			config,
			"app"
		);
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/startConcurrency 5000 exceeds the MCP cap of 200/);
	});
	test("names the unit the concurrency cap counts", () => {
		const res = checkLoadCaps(
			{ mode: "constant_concurrency", concurrency: 5000 },
			config,
			"app"
		);
		expect(res.error).toMatch(/exceeds the MCP cap of 200 virtual users\./);
	});
	test("accepts a startConcurrency at the cap", () => {
		expect(
			checkLoadCaps(
				{ mode: "ramp_up", concurrency: 200, startConcurrency: 200 },
				config,
				"app"
			).ok
		).toBe(true);
	});

	// An iterations run stops on a request count and never reads `duration`, so
	// `maxDurationSeconds` cannot bound it and `maxIterations` is what does.
	test("rejects an iterations run above the iterations cap", () => {
		const res = checkLoadCaps({ mode: "iterations", iterations: 1_000_000_000 }, config, "app");
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/iterations 1000000000 exceeds the MCP cap of 10000/);
	});
	test("accepts an iterations run at the cap", () => {
		expect(checkLoadCaps({ mode: "iterations", iterations: 10_000 }, config, "app").ok).toBe(
			true
		);
	});
	test("compares an omitted count against the engine's own default of 1000", () => {
		// An absent `iterations` is not "no iterations" - the engine runs 1000 -
		// so a cap under that has to refuse the run rather than wave it through.
		const tight = resolveSafetyConfig({ maxIterations: 500 });
		const res = checkLoadCaps({ mode: "iterations" }, tight, "app");
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/iterations 1000 exceeds the MCP cap of 500/);
		expect(checkLoadCaps({ mode: "iterations" }, config, "app").ok).toBe(true);
	});
	test("rejects a non-positive iterations count", () => {
		const res = checkLoadCaps({ mode: "iterations", iterations: -1 }, config, "app");
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/must be a positive whole number/);
	});
	test("an unrecognised mode carrying iterations is still bounded", () => {
		// `LoadStrategy::create` falls through to the iterations strategy for a
		// mode it cannot parse when the config has an `iterations` field, so a
		// guard keying on the mode string alone would wave this past.
		const res = checkLoadCaps({ mode: "burst", iterations: 1_000_000_000 }, config, "app");
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/exceeds the MCP cap of 10000/);
	});
	test("a duration-mode run is not held to the iterations cap", () => {
		expect(
			checkLoadCaps(
				{ mode: "constant_rps", iterations: 1_000_000_000, duration: "30s" },
				config,
				"app"
			).ok
		).toBe(true);
	});

	// The engine 400s a zero-length run, so the tool names the field instead of
	// starting a run that dies on arrival.
	test("rejects a zero duration", () => {
		const res = checkLoadCaps({ duration: "0s" }, config, "app");
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/must be greater than zero/);
	});
	test("still accepts a zero rampUpDuration (an instant ramp the engine allows)", () => {
		expect(
			checkLoadCaps({ mode: "ramp_up", rampUpDuration: "0s", duration: "30s" }, config, "app")
				.ok
		).toBe(true);
	});
});

describe("resolveLoadShape's duration under the cap", () => {
	const durationOf = (params: LoadRunParams, maxDurationSeconds: number) =>
		resolveLoadShape(params, resolveSafetyConfig({ maxDurationSeconds })).duration;

	test("sends the cap when it is under the engine's 60s default", () => {
		expect(durationOf({ mode: "constant_concurrency" }, 30)).toBe("30s");
	});
	test("sends the engine default when the cap already holds it", () => {
		expect(durationOf({ mode: "constant_concurrency" }, 300)).toBe("60s");
	});
	test("keeps the caller's duration", () => {
		expect(durationOf({ duration: "10s" }, 30)).toBe("10s");
	});
	test("sends nothing for an iterations run, which never reads duration", () => {
		expect(durationOf({ mode: "iterations", iterations: 10 }, 30)).toBeUndefined();
	});
});

describe("capacity discovery", () => {
	const config = resolveSafetyConfig({ maxConcurrency: 500, maxDurationSeconds: 300 });

	test("caps the ceiling the search climbs toward, not just a fixed target", () => {
		// `concurrency` is the ceiling in this mode rather than a level held, so
		// it is exactly the field that decides how large the run can get.
		expect(checkLoadCaps({ mode: "capacity", concurrency: 5000 }, config, "app").ok).toBe(
			false
		);
		expect(checkLoadCaps({ mode: "capacity", startConcurrency: 5000 }, config, "app").ok).toBe(
			false
		);
		expect(
			checkLoadCaps(
				{ mode: "capacity", startConcurrency: 4, concurrency: 256 },
				config,
				"app"
			).ok
		).toBe(true);
	});

	test("rejects a step duration the engine cannot read", () => {
		// It goes through the same string parser `duration` does, so a value the
		// engine would throw on has to fail here rather than at run time.
		expect(checkLoadCaps({ mode: "capacity", stepDuration: "a bit" }, config, "app").ok).toBe(
			false
		);
		expect(checkLoadCaps({ mode: "capacity", stepDuration: "5s" }, config, "app").ok).toBe(
			true
		);
	});

	test("is a duration mode, so the duration cap still reaches it", () => {
		// The guard mirrors `LoadStrategy::create`: an unrecognised mode with no
		// `iterations` falls through to a duration strategy. `capacity` is a
		// duration mode either way - the check is that adding it to the known
		// set did not accidentally route it to the iterations branch, which
		// takes no duration cap at all.
		const tight = resolveSafetyConfig({ maxDurationSeconds: 30 });
		expect(resolveLoadShape({ mode: "capacity" }, tight).duration).toBe("30s");
	});

	test("caps an omitted duration against this mode's own engine default", () => {
		// The regression: `capacity` falls back to 300s engine-side, not the 60s
		// every other mode uses. A 120s cap is *above* 60 and *below* 300, so a
		// guard keyed on one default injected nothing and let the search run
		// 2.5x over the ceiling.
		const cap = resolveSafetyConfig({ maxDurationSeconds: 120 });
		expect(resolveLoadShape({ mode: "capacity" }, cap).duration).toBe("120s");
		// The same cap over a 60s-default mode leaves that mode's default.
		expect(resolveLoadShape({ mode: "constant_concurrency" }, cap).duration).toBe("60s");
	});

	test("sends the capacity default once the cap clears it", () => {
		const roomy = resolveSafetyConfig({ maxDurationSeconds: 600 });
		expect(resolveLoadShape({ mode: "capacity" }, roomy).duration).toBe("300s");
	});
});

/**
 * A drift guard, not a restatement: the tables are what `start_load_run` sends
 * for an omitted field and what the caps judge, so they are only true if they
 * are the numbers the engine falls back to, and nothing else connects the
 * files. Same pattern as `src/constants/load-test.engine-parity.test.ts`. The
 * paths are held in the testkit, so CI routes an edit to either engine file back
 * to this suite rather than to the next unrelated change under `app/`.
 */
describe("the load default tables mirror the engine", () => {
	const [CONSTANTS_HPP, SCENARIO_LOAD_CPP] =
		ENGINE_READING_GUARDS.mcpSafetyCeiling.paths.map(fromRepoRoot);

	function read(path: string): string {
		const text = readFileSync(path, "utf8");
		// CLAUDE.md's documented failure mode: a source scan reading "" passes.
		expect(text.length, path).toBeGreaterThan(0);
		return text;
	}

	test("the single-target table is constants.hpp's run_config and capacity defaults", () => {
		const header = read(CONSTANTS_HPP);
		const constant = (name: string) => {
			const match = header.match(
				new RegExp(`constexpr\\s+int64_t\\s+${name}\\s*=\\s*(\\d+);`)
			);
			expect(match, `${name} not found in constants.hpp`).not.toBeNull();
			return Number(match![1]);
		};
		const concurrency = constant("DEFAULT_CONCURRENCY");
		// `MAX_CONCURRENCY` is declared in `run_config` and in `capacity`; the
		// capacity one is the search ceiling the table holds.
		const capacityBlock = header.match(
			/namespace capacity \{([\s\S]*?)\} \/\/ namespace capacity/
		);
		expect(capacityBlock, "namespace capacity not found in constants.hpp").not.toBeNull();
		const capacityCeiling = Number(
			capacityBlock![1].match(/constexpr\s+int64_t\s+MAX_CONCURRENCY\s*=\s*(\d+);/)?.[1]
		);
		expect(capacityCeiling).toBeGreaterThan(0);
		const durationSeconds = constant("DEFAULT_DURATION_MS") / 1000;
		const expected: Record<LoadMode, EngineLoadDefaults> = {
			constant_concurrency: { concurrency, durationSeconds, ratePaced: true },
			constant_rps: { concurrency, durationSeconds, ratePaced: true },
			ramp_up: {
				concurrency,
				startConcurrency: constant("DEFAULT_START_CONCURRENCY"),
				durationSeconds,
				rampUpDurationSeconds: constant("DEFAULT_RAMP_DURATION_MS") / 1000,
			},
			iterations: {
				concurrency: constant("DEFAULT_ITERATIONS_CONCURRENCY"),
				iterations: constant("DEFAULT_ITERATIONS"),
			},
			capacity: {
				concurrency: capacityCeiling,
				durationSeconds: constant("DEADLINE_MS") / 1000,
			},
		};
		expect(ENGINE_LOAD_DEFAULTS).toEqual(expected);
	});

	test("the scenario table is scenario_load.cpp's fallbacks", () => {
		const source = read(SCENARIO_LOAD_CPP);
		// `config.value ("concurrency", 10)` and `duration_field_ms (config,
		// "duration", 60000)`: the executor's fallbacks are literals, not named.
		const fallback = (field: string) => {
			const match = source.match(
				new RegExp(`\\(\\s*(?:config,\\s*)?"${field}",\\s*(\\d+)\\s*\\)`)
			);
			expect(match, `the "${field}" fallback not found in scenario_load.cpp`).not.toBeNull();
			return Number(match![1]);
		};
		const concurrency = fallback("concurrency");
		const durationSeconds = fallback("duration") / 1000;
		expect(SCENARIO_LOAD_DEFAULTS).toEqual({
			constant_concurrency: { concurrency, durationSeconds },
			ramp_up: {
				concurrency,
				startConcurrency: fallback("startConcurrency"),
				durationSeconds,
				rampUpDurationSeconds: fallback("rampUpDuration") / 1000,
			},
			iterations: { concurrency, iterations: fallback("iterations") },
		});
	});
});
