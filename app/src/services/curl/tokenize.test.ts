/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test } from "vitest";
import { tokenize, UnterminatedQuoteError } from "./tokenize";

describe("tokenize", () => {
	test("splits plain whitespace-separated args", () => {
		expect(tokenize("curl -X POST https://x.com")).toEqual([
			"curl",
			"-X",
			"POST",
			"https://x.com",
		]);
	});

	test("collapses repeated whitespace", () => {
		expect(tokenize("curl   -X    GET")).toEqual(["curl", "-X", "GET"]);
	});

	test("single quotes are literal", () => {
		expect(tokenize(`curl -H 'Accept: application/json'`)).toEqual([
			"curl",
			"-H",
			"Accept: application/json",
		]);
	});

	test("single quotes keep backslashes literal", () => {
		expect(tokenize(`curl -d 'a\\nb'`)).toEqual(["curl", "-d", "a\\nb"]);
	});

	test("double quotes honor escaped quote and backslash", () => {
		expect(tokenize(`curl -d "{\\"a\\":\\"b\\\\c\\"}"`)).toEqual([
			"curl",
			"-d",
			'{"a":"b\\c"}',
		]);
	});

	test("ANSI-C $'...' decodes escapes", () => {
		expect(tokenize(`curl -d $'line1\\nline2\\t\\'q\\''`)).toEqual([
			"curl",
			"-d",
			"line1\nline2\t'q'",
		]);
	});

	test("backslash line continuation (bash)", () => {
		const cmd = "curl -X POST \\\n  https://x.com \\\n  -H 'A: 1'";
		expect(tokenize(cmd)).toEqual(["curl", "-X", "POST", "https://x.com", "-H", "A: 1"]);
	});

	test("caret line continuation (cmd)", () => {
		const cmd = "curl -X POST ^\n  https://x.com";
		expect(tokenize(cmd)).toEqual(["curl", "-X", "POST", "https://x.com"]);
	});

	test("strips leading shell prompt", () => {
		expect(tokenize("$ curl https://x.com")).toEqual(["curl", "https://x.com"]);
	});

	test("preserves empty quoted argument", () => {
		expect(tokenize(`curl -d ''`)).toEqual(["curl", "-d", ""]);
	});

	test("preserves {{variables}} verbatim", () => {
		expect(tokenize("curl 'https://x.com?k={{token}}'")).toEqual([
			"curl",
			"https://x.com?k={{token}}",
		]);
	});

	test("throws on unterminated single quote", () => {
		expect(() => tokenize(`curl -d 'oops`)).toThrow(UnterminatedQuoteError);
	});

	test("throws on unterminated double quote", () => {
		expect(() => tokenize(`curl -d "oops`)).toThrow(UnterminatedQuoteError);
	});
});
