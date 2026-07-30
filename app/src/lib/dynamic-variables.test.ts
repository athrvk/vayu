/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test } from "vitest";
import {
	DYNAMIC_VARIABLES,
	containsDynamicVariable,
	isDynamicVariableName,
	isKnownDynamicVariable,
	resolveDynamicVariable,
} from "./dynamic-variables";

/** Every generator, by name, for the shape assertions below. */
const gen = (name: string): string => {
	const value = resolveDynamicVariable(name);
	expect(value).not.toBeNull();
	return value as string;
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("generator shapes", () => {
	test.each(["$guid", "$randomUUID"])("%s is a v4 UUID", (name) => {
		expect(gen(name)).toMatch(UUID_V4);
	});

	test("$timestamp is a plausible epoch in seconds", () => {
		const value = Number(gen("$timestamp"));
		expect(Number.isInteger(value)).toBe(true);
		// Seconds, not milliseconds - the difference is three orders of magnitude
		// and is exactly what a caller pasting it into a JWT `exp` would hit.
		const nowSeconds = Math.floor(Date.now() / 1000);
		expect(Math.abs(value - nowSeconds)).toBeLessThan(5);
	});

	test("$isoTimestamp parses back to about now", () => {
		const value = gen("$isoTimestamp");
		expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		expect(Math.abs(Date.parse(value) - Date.now())).toBeLessThan(5000);
	});

	test("$randomInt stays within 0 - 1000 over many draws", () => {
		for (let i = 0; i < 500; i++) {
			const value = Number(gen("$randomInt"));
			expect(Number.isInteger(value)).toBe(true);
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThanOrEqual(1000);
		}
	});

	test("$randomAlphaNumeric is a single alphanumeric character", () => {
		expect(gen("$randomAlphaNumeric")).toMatch(/^[a-zA-Z0-9]$/);
	});

	test("$randomBoolean is one of the two JSON booleans, and produces both", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) seen.add(gen("$randomBoolean"));
		expect([...seen].sort()).toEqual(["false", "true"]);
	});

	test("$randomEmail looks like an address", () => {
		expect(gen("$randomEmail")).toMatch(/^[a-z]+\.[a-z]+@[a-z.]+$/);
	});

	test("$randomIP is four octets in range", () => {
		for (let i = 0; i < 100; i++) {
			const octets = gen("$randomIP").split(".");
			expect(octets).toHaveLength(4);
			for (const octet of octets) {
				expect(Number(octet)).toBeGreaterThanOrEqual(0);
				expect(Number(octet)).toBeLessThanOrEqual(255);
			}
		}
	});

	test("$randomUrl is an absolute https URL", () => {
		const value = gen("$randomUrl");
		expect(() => new URL(value)).not.toThrow();
		expect(new URL(value).protocol).toBe("https:");
	});

	test("$randomPassword is 15 characters", () => {
		expect(gen("$randomPassword")).toHaveLength(15);
	});

	test.each(["$randomFirstName", "$randomLastName", "$randomFullName", "$randomCompanyName"])(
		"%s is non-empty text",
		(name) => {
			expect(gen(name).trim().length).toBeGreaterThan(0);
		}
	);

	test("every entry in the table produces a non-empty string", () => {
		expect(DYNAMIC_VARIABLES.length).toBeGreaterThan(0);
		for (const variable of DYNAMIC_VARIABLES) {
			expect(variable.generate()).not.toBe("");
			expect(variable.description.trim()).not.toBe("");
			expect(variable.name.startsWith("$")).toBe(true);
		}
	});

	test("names are unique", () => {
		const names = DYNAMIC_VARIABLES.map((v) => v.name);
		expect(new Set(names).size).toBe(names.length);
	});
});

describe("per-occurrence generation", () => {
	/*
	 * The rule a naive implementation gets wrong: a table of values computed once
	 * passes every shape test above and fails this one. Two ids that are equal
	 * are the failure people notice in production, in a load run, months later.
	 */
	test("consecutive calls to a random generator differ", () => {
		const values = new Set(Array.from({ length: 50 }, () => gen("$guid")));
		expect(values.size).toBe(50);
	});

	test("the table exposes functions, not precomputed values", () => {
		for (const variable of DYNAMIC_VARIABLES) {
			expect(typeof variable.generate).toBe("function");
		}
	});
});

describe("unknown and non-dynamic names", () => {
	test("an unknown $name resolves to null rather than an empty string", () => {
		// The defect this table exists to fix: a typo that silently sends "".
		expect(resolveDynamicVariable("$randomInteger")).toBeNull();
		expect(resolveDynamicVariable("$guidd")).toBeNull();
	});

	test("isDynamicVariableName is about the prefix, isKnownDynamicVariable about the table", () => {
		expect(isDynamicVariableName("$anything")).toBe(true);
		expect(isDynamicVariableName("baseUrl")).toBe(false);
		expect(isKnownDynamicVariable("$anything")).toBe(false);
		expect(isKnownDynamicVariable("$guid")).toBe(true);
	});

	test("resolving a plain name is not this table's job", () => {
		expect(resolveDynamicVariable("baseUrl")).toBeNull();
	});
});

describe("containsDynamicVariable", () => {
	test("finds a known generator anywhere in the string", () => {
		expect(containsDynamicVariable("https://x/y?id={{$guid}}")).toBe(true);
		expect(containsDynamicVariable("{{ $timestamp }}")).toBe(true);
	});

	test("ignores ordinary variables, unknown generators and empty input", () => {
		expect(containsDynamicVariable("https://{{baseUrl}}/y")).toBe(false);
		expect(containsDynamicVariable("{{$randomInteger}}")).toBe(false);
		expect(containsDynamicVariable("")).toBe(false);
		expect(containsDynamicVariable(undefined)).toBe(false);
	});

	test("is not made stateful by the shared global regex", () => {
		// VARIABLE_PATTERN is module-global and `g`-flagged; matchAll clones it,
		// but a switch to `.test()` here would carry lastIndex between calls and
		// make every second call answer wrongly.
		const input = "{{$guid}}";
		expect(containsDynamicVariable(input)).toBe(true);
		expect(containsDynamicVariable(input)).toBe(true);
	});
});
