/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The snippet generators, against the inputs that break generators.
 *
 * Quoting is the whole risk surface here, so the body matrix is hostile on
 * purpose: single quotes (the one character POSIX single-quoting cannot hold),
 * double quotes and backslashes (the ones a JS literal cannot), newlines,
 * `$`/backtick shell expansions, and unicode. Each case asserts the *decoded*
 * value rather than a literal expected string, so a rule that escapes correctly
 * in a different-but-valid way still passes and a rule that loses a byte does
 * not.
 */

import { describe, it, expect } from "vitest";
import {
	CODE_TARGETS,
	SECRET_PLACEHOLDER,
	authSecrets,
	generateCurl,
	generateFetch,
	generateSnippet,
	type SnippetRequest,
} from "./index";

const GET: SnippetRequest = { method: "get", url: "https://api.example.com/v1/users" };

/**
 * Undo POSIX single-quoting, so a test can assert the value curl will actually
 * receive instead of the exact bytes we chose to write it as.
 */
function unquoteShell(quoted: string): string {
	const match = /^'([\s\S]*)'$/.exec(quoted);
	if (!match) throw new Error(`not single-quoted: ${quoted}`);
	return match[1].split(`'\\''`).join("'");
}

/** The `--data-raw` argument of a generated curl command, decoded. */
function curlBody(code: string): string {
	const marker = "--data-raw ";
	const start = code.indexOf(marker);
	expect(start).toBeGreaterThan(-1);
	return unquoteShell(code.slice(start + marker.length).trim());
}

/** The `body:` string literal of a generated fetch snippet, decoded. */
function fetchBody(code: string): string {
	const line = code.split("\n").find((l) => l.trimStart().startsWith("body: "));
	expect(line).toBeDefined();
	return JSON.parse(line!.trim().slice("body: ".length).replace(/,$/, "")) as string;
}

const HOSTILE: Array<[string, string]> = [
	["single quotes", `{"note":"it's fine, isn't it"}`],
	["double quotes and backslashes", `{"path":"C:\\\\tmp","q":"say \\"hi\\""}`],
	["newlines", "line one\nline two\r\nline three"],
	["shell expansions", "$HOME `whoami` ${PATH} $(id)"],
	["unicode", '{"greeting":"नमस्ते 🌍 café"}'],
	["a lone quote", "'"],
];

describe("curl - the body survives quoting", () => {
	for (const [name, content] of HOSTILE) {
		it(`round-trips ${name}`, () => {
			const { code } = generateCurl({
				...GET,
				method: "POST",
				body: { mode: "json", content },
			});
			expect(curlBody(code)).toBe(content);
		});
	}

	it("never leaves a shell expansion unquoted", () => {
		const { code } = generateCurl({
			...GET,
			method: "POST",
			body: { mode: "text", content: "$(rm -rf /)" },
		});
		// Inside single quotes a POSIX shell expands nothing at all - the whole
		// reason every value is wrapped in them.
		expect(code).toContain(`'$(rm -rf /)'`);
	});

	it("omits a body entirely when there is none", () => {
		expect(generateCurl(GET).code).not.toContain("--data");
		expect(generateCurl({ ...GET, body: { mode: "none" } }).code).not.toContain("--data");
		expect(generateCurl({ ...GET, body: { mode: "json", content: "" } }).code).not.toContain(
			"--data"
		);
	});

	it("uppercases the method and quotes the URL", () => {
		expect(generateCurl(GET).code).toContain(`curl -X GET 'https://api.example.com/v1/users'`);
	});
});

describe("fetch - the body survives escaping", () => {
	for (const [name, content] of HOSTILE) {
		it(`round-trips ${name}`, () => {
			const { code } = generateFetch({
				...GET,
				method: "POST",
				body: { mode: "json", content },
			});
			expect(fetchBody(code)).toBe(content);
		});
	}

	it("puts no raw newline inside a string literal", () => {
		const { code } = generateFetch({
			...GET,
			method: "POST",
			body: { mode: "text", content: "a\nb" },
		});
		// A literal newline inside `"` is a syntax error, which is what a
		// hand-rolled escape table forgets.
		expect(code).toContain(String.raw`"a\nb"`);
	});
});

describe("form bodies", () => {
	const formData: SnippetRequest = {
		...GET,
		method: "POST",
		headers: { "Content-Type": "multipart/form-data" },
		body: {
			mode: "form-data",
			fields: [
				{ key: "name", value: "it's me" },
				{ key: "skip", value: "no", enabled: false },
			],
		},
	};

	it("emits one -F per enabled field and drops the boundary-less Content-Type", () => {
		const { code } = generateCurl(formData);
		expect(code).toContain(`-F 'name=it'\\''s me'`);
		// curl picks the boundary; a Content-Type naming one it did not choose
		// makes the server read the whole body as a single part.
		expect(code).not.toContain("multipart/form-data");
		expect(code).not.toContain("skip");
	});

	it("builds a FormData and says why Content-Type is gone", () => {
		const { code, notes } = generateFetch(formData);
		expect(code).toContain("const body = new FormData();");
		expect(code).toContain(`body.append("name", "it's me");`);
		expect(code).toContain("body,");
		expect(code).not.toContain("multipart/form-data");
		expect(notes.join(" ")).toContain("boundary");
	});

	it("urlencodes rather than raw-posting the x-www-form-urlencoded mode", () => {
		const urlencoded: SnippetRequest = {
			...GET,
			method: "POST",
			body: { mode: "x-www-form-urlencoded", fields: [{ key: "q", value: "a b&c" }] },
		};
		expect(generateCurl(urlencoded).code).toContain(`--data-urlencode 'q=a b&c'`);
		expect(generateFetch(urlencoded).code).toContain("new URLSearchParams()");
	});
});

describe("auth is applied, because the engine applies it at send time", () => {
	it("turns bearer into an Authorization header", () => {
		const request: SnippetRequest = { ...GET, auth: { mode: "bearer", token: "t0ken" } };
		expect(generateCurl(request).code).toContain(`-H 'Authorization: Bearer t0ken'`);
		expect(generateFetch(request).code).toContain(`"Authorization": "Bearer t0ken"`);
	});

	it("uses -u for basic, and btoa for fetch", () => {
		const request: SnippetRequest = {
			...GET,
			auth: { mode: "basic", username: "ada", password: "p'ass" },
		};
		expect(generateCurl(request).code).toContain(`-u 'ada:p'\\''ass'`);
		expect(generateFetch(request).code).toContain(`"Basic " + btoa("ada:p'ass")`);
	});

	it("puts an api key in the header or the query, as configured", () => {
		const header = generateCurl({
			...GET,
			auth: { mode: "apikey", key: "X-Key", value: "abc", in: "header" },
		});
		expect(header.code).toContain(`-H 'X-Key: abc'`);

		const query = generateCurl({
			...GET,
			url: "https://api.example.com/v1/users?page=2#frag",
			auth: { mode: "apikey", key: "api key", value: "a b", in: "query" },
		});
		// Appended before the fragment - after it, the parameter never reaches
		// the server - and percent-encoded.
		expect(query.code).toContain("?page=2&api%20key=a%20b#frag");
	});

	it("says so when the mode cannot be reproduced statically", () => {
		const { code, notes } = generateCurl({
			...GET,
			auth: { mode: "oauth2", config: { clientId: "id" } },
		});
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("OAuth 2.0");
		// The note is the whole point: nothing pretends a token was attached.
		expect(code).not.toContain("Authorization");
	});

	it("sends nothing for none/noauth", () => {
		expect(generateCurl({ ...GET, auth: { mode: "noauth" } }).notes).toEqual([]);
		expect(generateCurl({ ...GET, auth: { mode: "noauth" } }).code).not.toContain(
			"Authorization"
		);
	});

	it("names the credential values a caller should mask", () => {
		expect(authSecrets({ mode: "bearer", token: "t" })).toEqual(["t"]);
		expect(authSecrets({ mode: "basic", username: "ada", password: "p" })).toEqual(["p"]);
		expect(authSecrets({ mode: "apikey", key: "K", value: "v" })).toEqual(["v"]);
		expect(authSecrets(undefined)).toEqual([]);
		expect(authSecrets({ mode: "oauth2" })).toEqual([]);
	});
});

describe("secret masking", () => {
	const request: SnippetRequest = {
		method: "POST",
		url: "https://api.example.com/v1/users?token=s3cret",
		headers: { "X-Auth": "s3cret", "X-Other": "public" },
		body: { mode: "json", content: `{"key":"s3cret"}` },
		auth: { mode: "bearer", token: "s3cret" },
	};

	it("hides the value everywhere it landed, not just in the auth field", () => {
		const { code, masked } = generateCurl(request, { secrets: ["s3cret"], mask: true });
		expect(code).not.toContain("s3cret");
		// URL, header, body and the Authorization line all substituted.
		expect(code.split(SECRET_PLACEHOLDER)).toHaveLength(5);
		expect(code).toContain("public");
		expect(masked).toBe(true);
	});

	it("leaves the value alone when masking is off", () => {
		const { code, masked } = generateCurl(request, { secrets: ["s3cret"], mask: false });
		expect(code).toContain("s3cret");
		expect(masked).toBe(false);
	});

	it("reports masked=false when no secret was actually present", () => {
		expect(generateCurl(GET, { secrets: ["absent"], mask: true }).masked).toBe(false);
	});

	it("ignores an empty or whitespace secret instead of shredding the output", () => {
		// A variable set to "" is `includes("")` everywhere - masking on it would
		// replace between every character of the command.
		const { code } = generateCurl(request, { secrets: ["", "   "], mask: true });
		expect(code).toContain("s3cret");
		expect(code).not.toContain(SECRET_PLACEHOLDER);
	});

	it("masks the longer of two overlapping secrets whole", () => {
		const { code } = generateCurl(
			{ ...GET, headers: { "X-A": "abcdef" } },
			{ secrets: ["abc", "abcdef"], mask: true }
		);
		// Shortest-first would mask "abc" and leave "def" in the clear.
		expect(code).toContain(`'X-A: ${SECRET_PLACEHOLDER}'`);
		expect(code).not.toContain("def");
	});

	it("masks a value that itself contains a quote, which quoting would hide", () => {
		// Masking after quoting would search for `it's` in a string where it has
		// become `it'\''s` and find nothing.
		const { code } = generateCurl(
			{ ...GET, method: "POST", body: { mode: "text", content: "it's secret" } },
			{ secrets: ["it's secret"], mask: true }
		);
		expect(code).toContain(`--data-raw '${SECRET_PLACEHOLDER}'`);
	});
});

describe("the target registry", () => {
	it("dispatches by id", () => {
		expect(generateSnippet("curl", GET).code).toBe(generateCurl(GET).code);
		expect(generateSnippet("fetch", GET).code).toBe(generateFetch(GET).code);
	});

	it("throws on an unknown target rather than guessing a language", () => {
		expect(() => generateSnippet("httpie" as (typeof CODE_TARGETS)[number]["id"], GET)).toThrow(
			/Unknown code target/
		);
	});

	it("every registered target generates something for a bare GET", () => {
		expect(CODE_TARGETS.length).toBeGreaterThan(0);
		for (const target of CODE_TARGETS) {
			expect(target.generate(GET).code.length).toBeGreaterThan(0);
		}
	});
});
