/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import {
	buildSafetyConfigFromEnv,
	DEFAULT_MCP_SAFETY_CONFIG,
	normalizeHost,
	resolveSafetyConfig,
	sanitizeSafetyInput,
} from "./config.js";
import { checkAllowlist, checkLoadCaps } from "./safety.js";

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
		const { config, ignored } = buildSafetyConfigFromEnv({
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
		const { config, ignored } = buildSafetyConfigFromEnv({});

		expect(config).toEqual(DEFAULT_MCP_SAFETY_CONFIG);
		expect(ignored).toEqual([]);
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
