/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test } from "vitest";
import { extractHost, checkAllowlist, parseDurationSeconds, checkLoadCaps } from "./safety.js";
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
});
