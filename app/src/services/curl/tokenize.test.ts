/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test } from "vitest";
import { chromeBashCopy, chromeCmdCopy, chromeCopyArgv } from "./chrome-copy.testkit";
import { tokenize, tokenizeCommand, UnterminatedQuoteError } from "./tokenize";

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
		const chromeCmd = chromeCmdCopy;
		const chromeBash = chromeBashCopy;
		const expected = chromeCopyArgv;

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

describe("tokenizeCommand - shell variables (#3777)", () => {
	/** The argument after `curl -d`, the one place each case below varies. */
	const read = (arg: string) => {
		const { tokens, variables } = tokenizeCommand(`curl -d ${arg}`);
		return { arg: tokens[2], variables };
	};

	test.each([
		["unquoted $NAME", "$NAME", "{{NAME}}"],
		["unquoted ${NAME}", "${NAME}", "{{NAME}}"],
		["double-quoted $NAME", '"$NAME"', "{{NAME}}"],
		["double-quoted ${NAME}", '"${NAME}"', "{{NAME}}"],
		["a name inside text", '"Bearer $OPENAI_API_KEY"', "Bearer {{OPENAI_API_KEY}}"],
		["a name ending where the text goes on", '"$A-b"', "{{A}}-b"],
		["braces that end a name early", '"${A}b"', "{{A}}b"],
		["an underscore-led name", "$_x1", "{{_x1}}"],
		["a name split from a quoted tail", `$A'$B'`, "{{A}}$B"],
	])("converts %s", (_name, written, expected) => {
		expect(read(written).arg).toBe(expected);
	});

	test.each([
		["single quotes", "'$NAME'", "$NAME"],
		["single quotes around ${NAME}", "'${NAME}'", "${NAME}"],
		["ANSI-C quotes", "$'$NAME'", "$NAME"],
		["a command substitution", '"$(date)"', "$(date)"],
		["an unquoted command substitution", "$(date)", "$(date)"],
		["a backtick substitution", '"`date`"', "`date`"],
		["a positional parameter", "$1", "$1"],
		["a special parameter", '"$? $@ $* $# $!"', "$? $@ $* $# $!"],
		["the process id", "$$", "$$"],
		["a name behind the process id", "$$NAME", "$$NAME"],
		["a trailing dollar", '"cost$"', "cost$"],
		["a dollar and a space", '"a $ b"', "a $ b"],
		["a default-value expansion", '"${NAME:-x}"', "${NAME:-x}"],
		["a length expansion", '"${#NAME}"', "${#NAME}"],
		["an unterminated brace form", '"${NAME"', "${NAME"],
		["an escaped dollar outside quotes", "\\$NAME", "$NAME"],
		["an escaped dollar in double quotes", '"\\$NAME"', "$NAME"],
	])("leaves %s as written", (_name, written, expected) => {
		const { arg, variables } = read(written);

		expect(arg).toBe(expected);
		expect(variables).toEqual([]);
	});

	test.each([
		["a bare span", "{{$guid}}", "{{$guid}}"],
		["a double-quoted span", '"{{$guid}}"', "{{$guid}}"],
		["a span with spaces", '"{{ $randomInt }}"', "{{ $randomInt }}"],
		["a span among text", '"id={{$randomInt}}"', "id={{$randomInt}}"],
	])("keeps the dollar of %s", (_name, written, expected) => {
		expect(read(written)).toEqual({ arg: expected, variables: [] });
	});

	test("still converts a dollar beside, not inside, a {{ ... }} span", () => {
		expect(read('"{{a}}$B{{$guid}}"')).toEqual({
			arg: "{{a}}{{B}}{{$guid}}",
			variables: ["B"],
		});
	});

	test("lists each variable once, in the order first seen", () => {
		const { tokens, variables } = tokenizeCommand(
			`curl https://$HOST/$PATH_ID -H "A: $KEY" -H "B: \${KEY}-$HOST" -d $ZED`
		);

		expect(variables).toEqual(["HOST", "PATH_ID", "KEY", "ZED"]);
		expect(tokens).toEqual([
			"curl",
			"https://{{HOST}}/{{PATH_ID}}",
			"-H",
			"A: {{KEY}}",
			"-H",
			"B: {{KEY}}-{{HOST}}",
			"-d",
			"{{ZED}}",
		]);
	});

	test("reports nothing for a command with no variables", () => {
		expect(tokenizeCommand("curl https://x.com -H 'A: $B'").variables).toEqual([]);
	});

	test("is what tokenize returns the tokens of", () => {
		const command = `curl -H "Authorization: Bearer $KEY" https://x.com`;

		expect(tokenize(command)).toEqual(tokenizeCommand(command).tokens);
	});

	test("reads no variable out of Chrome's cmd copy, where a dollar is ordinary", () => {
		const cmd = [
			String.raw`curl ^"https://x.com/$HOST^" ^`,
			String.raw`  -H ^"A: $KEY^" -d ^"a\$b^"`,
		].join("\n");

		expect(tokenizeCommand(cmd)).toEqual({
			tokens: ["curl", "https://x.com/$HOST", "-H", "A: $KEY", "-d", String.raw`a\$b`],
			variables: [],
		});
	});
});
