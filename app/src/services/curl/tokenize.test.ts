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

	describe("ANSI-C numeric escapes", () => {
		test.each([
			["\\a \\b \\e \\E \\f \\v", "\x07 \b \x1b \x1b \f \v"],
			["caf\\u00e9", "café"],
			["\\u00e9", "é"],
			["\\U0001F600", "😀"],
			["\\ud83d\\ude00", "😀"],
			["\\u41", "A"],
			["\\x41\\x62", "Ab"],
			["\\101\\142", "Ab"],
			["\\0101", "\b1"],
			["\\xc3\\xa9", "é"],
			["\\303\\251", "é"],
			["\\xf0\\x9f\\x98\\x80", "😀"],
			["a\\xe2\\x82\\xacb", "a€b"],
			["\\xff", "\u00ff"],
			["\\xc3(", "\u00c3("],
			["\\xe2\\x82", "\u00e2\u0082"],
			["\\xef\\xbb\\xbfx", "\ufeffx"],
		])("$'%s'", (body, expected) => {
			expect(tokenize(`curl -d $'${body}'`)).toEqual(["curl", "-d", expected]);
		});

		test("literal non-ASCII characters pass through", () => {
			expect(tokenize("curl -d $'café'")).toEqual(["curl", "-d", "café"]);
		});

		test.each([
			["\\xZ", "\\xZ"],
			["\\u", "\\u"],
			["\\Uzz", "\\Uzz"],
			["\\U00110000", "\\U00110000"],
		])("an escape with no valid digits stays as written: %s", (body, expected) => {
			expect(tokenize(`curl -d $'${body}'`)).toEqual(["curl", "-d", expected]);
		});

		test("a byte run is flushed before the next ordinary character", () => {
			expect(tokenize(`curl -d $'\\xc3\\xa9\\xc3\\xa9x\\xc3\\xa9'`)).toEqual([
				"curl",
				"-d",
				"ééxé",
			]);
		});

		test("an escaped quote does not end the string after a numeric escape", () => {
			expect(tokenize(`curl -d $'\\u00e9\\'x'`)).toEqual(["curl", "-d", "é'x"]);
		});

		test("still throws on an unterminated string ending in a numeric escape", () => {
			expect(() => tokenize(`curl -d $'\\u00e9`)).toThrow(UnterminatedQuoteError);
		});
	});

	describe("Chrome Copy as cURL (cmd)", () => {
		// What Chrome writes for a POST with a JSON body: every argument is ^"..."
		// quoted, a quote inside it is ^\^", a backslash ^\^\, and ^ also guards
		// & % { } [ ] , ! < > |.
		const chromeCmd = [
			String.raw`curl ^"https://api.example.com/v1/users?x=1^&y=2^" ^`,
			String.raw`  -H ^"accept: application/json^" ^`,
			String.raw`  -H ^"content-type: application/json^" ^`,
			String.raw`  -b ^"session=abc^%^3D^" ^`,
			String.raw`  --data-raw ^"^{^\^"name^\^":^\^"Ada Lovelace^\^",^\^"tags^\^":^[^\^"a^\^",^\^"b^\^"^],^\^"path^\^":^\^"C:^\^\^\^\tmp^\^",^\^"rate^\^":^\^"5^%^\^"^}^" ^`,
			String.raw`  --compressed`,
		].join("\n");

		const chromeBash = [
			`curl 'https://api.example.com/v1/users?x=1&y=2' \\`,
			`  -H 'accept: application/json' \\`,
			`  -H 'content-type: application/json' \\`,
			`  -b 'session=abc%3D' \\`,
			`  --data-raw '{"name":"Ada Lovelace","tags":["a","b"],"path":"C:\\\\tmp","rate":"5%"}' \\`,
			`  --compressed`,
		].join("\n");

		const expected = [
			"curl",
			"https://api.example.com/v1/users?x=1&y=2",
			"-H",
			"accept: application/json",
			"-H",
			"content-type: application/json",
			"-b",
			"session=abc%3D",
			"--data-raw",
			String.raw`{"name":"Ada Lovelace","tags":["a","b"],"path":"C:\\tmp","rate":"5%"}`,
			"--compressed",
		];

		test("a cmd copy tokenizes to the same argv as the bash copy", () => {
			expect(tokenize(chromeCmd)).toEqual(expected);
			expect(tokenize(chromeBash)).toEqual(expected);
		});

		test("a cmd copy with CRLF line endings tokenizes the same", () => {
			expect(tokenize(chromeCmd.replace(/\n/g, "\r\n"))).toEqual(expected);
		});

		test("^^ is a literal caret and ^ before a newline in a body is dropped", () => {
			const cmd = [
				String.raw`curl ^"https://x.com^" ^`,
				String.raw`  -d ^"a^^b^`,
				`c^"`,
			].join("\n");
			expect(tokenize(cmd)).toEqual(["curl", "https://x.com", "-d", "a^bc"]);
		});

		test("a caret before a newline after ^^ stays a literal caret", () => {
			const cmd = [String.raw`curl ^"https://x.com^" -d ^"a^^`, `b^"`].join("\n");
			expect(tokenize(cmd)).toEqual(["curl", "https://x.com", "-d", "a^\nb"]);
		});

		test("a POSIX command with a literal caret is untouched", () => {
			expect(tokenize(`curl https://x.com -d '{"re":"^"}' -H "X: a^b"`)).toEqual([
				"curl",
				"https://x.com",
				"-d",
				'{"re":"^"}',
				"-H",
				"X: a^b",
			]);
		});

		test('a lone ^" inside a POSIX quote does not switch to cmd mode', () => {
			expect(tokenize(`curl -d 'x ^"y' https://x.com`)).toEqual([
				"curl",
				"-d",
				'x ^"y',
				"https://x.com",
			]);
		});
	});
});
