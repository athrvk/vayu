/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import {
	DEFAULT_MCP_SAFETY_CONFIG,
	normalizeHost,
	resolveSafetyConfig,
	sanitizeSafetyInput,
} from "./config.js";

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
});

describe("sanitizeSafetyInput", () => {
	it("normalizes and de-duplicates allowlist hosts", () => {
		const out = sanitizeSafetyInput({
			allowlist: ["https://api.example.com/x", "API.EXAMPLE.COM", "  ", "localhost:9876"],
		});
		expect(out.allowlist).toEqual(["api.example.com", "localhost"]);
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
	});

	it("keeps allowWrites only when it is a boolean", () => {
		expect(sanitizeSafetyInput({ allowWrites: true }).allowWrites).toBe(true);
		expect(
			sanitizeSafetyInput({ allowWrites: "yes" as unknown as boolean }).allowWrites
		).toBeUndefined();
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
