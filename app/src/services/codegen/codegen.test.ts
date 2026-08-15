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
	generateHttpie,
	generatePowerShell,
	generatePython,
	generateSnippet,
	type SnippetRequest,
} from "./index";
import { parseCommand } from "@/services/curl/parseCurl";

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

	it("emits one --form-string per enabled field and drops the boundary-less Content-Type", () => {
		const { code } = generateCurl(formData);
		expect(code).toContain(`--form-string 'name=it'\\''s me'`);
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

	/**
	 * A file part is a path the engine opens at send time (issue #393), so every
	 * generator has to say something about it: four of these clients can express
	 * one, and `fetch` cannot open a local path at all. Before this, a file part
	 * arrived here as a field with an empty value and each snippet posted a part
	 * that was silently not the file.
	 */
	describe("a file part", () => {
		const withFile: SnippetRequest = {
			...GET,
			method: "POST",
			body: {
				mode: "form-data",
				fields: [
					{ key: "caption", value: "hi" },
					{
						key: "avatar",
						value: "",
						type: "file",
						src: "/tmp/a.png",
						fileName: "profile.png",
						contentType: "image/png",
					},
				],
			},
		};

		it("curl uploads it with -F, the inverse of what parseCurl reads", () => {
			const { code } = generateCurl(withFile);
			expect(code).toContain(`-F 'avatar=@/tmp/a.png;type=image/png;filename=profile.png'`);
			// The text part still goes through --form-string, where a leading `@`
			// is not a file reference.
			expect(code).toContain(`--form-string 'caption=hi'`);
		});

		it("httpie uploads it with the file item and names what it cannot carry", () => {
			const { code, notes } = generateHttpie(withFile);
			expect(code).toContain("'avatar@/tmp/a.png'");
			// HTTPie names the part after the file on disk, so a declared name that
			// differs from the basename is stated rather than silently changed.
			expect(notes.join(" ")).toContain("is sent as a.png");
		});

		it("python opens the file in the files dict", () => {
			const { code } = generatePython(withFile);
			expect(code).toContain(
				`"avatar": ("profile.png", open("/tmp/a.png", "rb"), "image/png"),`
			);
			expect(code).toContain("files=files,");
		});

		it("powershell hands -Form a FileInfo", () => {
			const { code } = generatePowerShell(withFile);
			expect(code).toContain("'avatar' = Get-Item -LiteralPath '/tmp/a.png'");
			expect(code).toContain("-Form $body");
		});

		it("fetch says it cannot read a path rather than dropping the part", () => {
			const { code, notes } = generateFetch(withFile);
			expect(code).toContain("/tmp/a.png");
			expect(notes.join(" ")).toContain("avatar");
			expect(notes.join(" ")).toContain("File or Blob");
		});

		it("hides a secret that appears inside the path", () => {
			const { code, masked } = generateCurl(
				{
					...withFile,
					body: {
						mode: "form-data",
						fields: [
							{ key: "avatar", value: "", type: "file", src: "/home/s3cr3t/a.png" },
						],
					},
				},
				{ mask: true, secrets: ["s3cr3t"] }
			);
			expect(code).not.toContain("s3cr3t");
			expect(masked).toBe(true);
		});
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

/**
 * The three targets added after curl and fetch, each with its own quoting rule.
 *
 * The shared half - auth flattening, secret masking, which body mode is which -
 * is `prepare.ts` and is already covered above, so these cases are about the
 * part that cannot be shared: how each language spells a string, and which
 * argument makes it send multipart rather than urlencoded. Every body case
 * decodes the emitted literal rather than comparing to one, so a different but
 * correct escaping still passes.
 */

/** Undo PowerShell single-quoting: the only escape is a doubled quote. */
function unquotePowerShell(quoted: string): string {
	const match = /^'([\s\S]*)'$/.exec(quoted);
	if (!match) throw new Error(`not single-quoted: ${quoted}`);
	return match[1].split("''").join("'");
}

describe("HTTPie", () => {
	for (const [name, content] of HOSTILE) {
		it(`round-trips ${name} through --raw`, () => {
			const { code } = generateHttpie({
				...GET,
				method: "POST",
				body: { mode: "json", content },
			});
			const marker = "--raw ";
			const raw = code.slice(code.indexOf(marker) + marker.length).trim();
			expect(unquoteShell(raw)).toBe(content);
		});
	}

	it("writes headers as bare Name:value words, not -H pairs", () => {
		const { code } = generateHttpie({ ...GET, headers: { Accept: "application/json" } });
		expect(code).toContain("http GET 'https://api.example.com/v1/users'");
		expect(code).toContain(`'Accept:application/json'`);
		expect(code).not.toContain("-H ");
	});

	it("uses -a for basic auth", () => {
		const { code } = generateHttpie({
			...GET,
			auth: { mode: "basic", username: "ada", password: "p'ass" },
		});
		expect(code).toContain(`-a 'ada:p'\\''ass'`);
	});

	it("asks for multipart explicitly, since --form alone is urlencoded", () => {
		const { code } = generateHttpie({
			...GET,
			method: "POST",
			headers: { "Content-Type": "multipart/form-data" },
			body: { mode: "form-data", fields: [{ key: "name", value: "ada" }] },
		});
		// Without `--multipart`, HTTPie sends a urlencoded body for a request Vayu
		// sends as multipart - silently, which is the whole risk.
		expect(code).toContain("--multipart");
		expect(code).toContain(`'name=ada'`);
		expect(code).not.toContain("multipart/form-data");
	});

	it("uses --form for the urlencoded mode", () => {
		const { code } = generateHttpie({
			...GET,
			method: "POST",
			body: { mode: "x-www-form-urlencoded", fields: [{ key: "q", value: "a b" }] },
		});
		expect(code).toContain("--form");
		expect(code).not.toContain("--multipart");
		expect(code).toContain(`'q=a b'`);
	});
});

describe("PowerShell", () => {
	for (const [name, content] of HOSTILE) {
		it(`round-trips ${name}`, () => {
			const { code } = generatePowerShell({
				...GET,
				method: "POST",
				body: { mode: "json", content },
			});
			// Sliced to the blank line, not to the end of a line: a PowerShell
			// single-quoted string may span lines, and a newline body is exactly
			// the case where splitting on "\n" would read back a truncated value
			// and pass anyway.
			const start = code.indexOf("$body = ") + "$body = ".length;
			const end = code.indexOf("\n\n", start);
			expect(unquotePowerShell(code.slice(start, end))).toBe(content);
		});
	}

	it("escapes a quote by doubling it, never the POSIX way", () => {
		const { code } = generatePowerShell({
			...GET,
			method: "POST",
			body: { mode: "text", content: "it's here" },
		});
		expect(code).toContain(`'it''s here'`);
		// A POSIX `'\''` here puts a literal backslash in the data and leaves the
		// string unterminated.
		expect(code).not.toContain(String.raw`'\''`);
	});

	it("leaves a PowerShell expansion literal inside single quotes", () => {
		const { code } = generatePowerShell({
			...GET,
			method: "POST",
			body: { mode: "text", content: "$env:PATH `whoami`" },
		});
		expect(code).toContain("'$env:PATH `whoami`'");
	});

	it("calls Invoke-RestMethod rather than curl, which is an alias for it", () => {
		const { code } = generatePowerShell(GET);
		expect(code).toContain("Invoke-RestMethod");
		expect(code).toContain("-Method GET");
		expect(code).not.toContain("curl");
	});

	it("builds the basic header inline rather than a PSCredential", () => {
		const { code } = generatePowerShell({
			...GET,
			auth: { mode: "basic", username: "ada", password: "pass" },
		});
		expect(code).toContain("[Convert]::ToBase64String");
		expect(code).toContain("'ada:pass'");
		expect(code).not.toContain("-Credential");
	});

	it("uses -Form for multipart and -Body for urlencoded", () => {
		const multipart = generatePowerShell({
			...GET,
			method: "POST",
			body: { mode: "form-data", fields: [{ key: "a", value: "b" }] },
		});
		expect(multipart.code).toContain("-Form $body");

		const urlencoded = generatePowerShell({
			...GET,
			method: "POST",
			body: { mode: "x-www-form-urlencoded", fields: [{ key: "a", value: "b" }] },
		});
		expect(urlencoded.code).toContain("-Body $body");
		expect(urlencoded.code).not.toContain("-Form");
	});
});

describe("Python requests", () => {
	for (const [name, content] of HOSTILE) {
		it(`round-trips ${name}`, () => {
			const { code } = generatePython({
				...GET,
				method: "POST",
				body: { mode: "json", content },
			});
			const line = code.split("\n").find((l) => l.startsWith("data = "))!;
			// JSON's escape set is a strict subset of Python's and means the same
			// thing in both, so parsing the literal back as JSON is a faithful read.
			expect(JSON.parse(line.slice("data = ".length))).toBe(content);
		});
	}

	it("imports requests and prints the outcome", () => {
		const { code } = generatePython(GET);
		expect(code.startsWith("import requests")).toBe(true);
		expect(code).toContain('requests.request(\n    "GET",');
		expect(code).toContain("print(response.status_code, response.text)");
	});

	it("sends a composed body with data=, not json=, which would re-serialize it", () => {
		const { code } = generatePython({
			...GET,
			method: "POST",
			body: { mode: "json", content: '{"a":1}' },
		});
		expect(code).toContain("data=data,");
		expect(code).not.toContain("json=");
	});

	it("uses files= for multipart and data= for urlencoded", () => {
		const multipart = generatePython({
			...GET,
			method: "POST",
			body: { mode: "form-data", fields: [{ key: "a", value: "b" }] },
		});
		// `files=` is what makes requests send multipart; a multipart body passed
		// as `data=` is silently urlencoded.
		expect(multipart.code).toContain("files=files,");

		const urlencoded = generatePython({
			...GET,
			method: "POST",
			body: { mode: "x-www-form-urlencoded", fields: [{ key: "a", value: "b" }] },
		});
		expect(urlencoded.code).toContain("data=data,");
		expect(urlencoded.code).not.toContain("files=");
	});

	it("passes basic auth as the tuple requests takes", () => {
		const { code } = generatePython({
			...GET,
			auth: { mode: "basic", username: "ada", password: 'p"ass' },
		});
		expect(code).toContain('auth = ("ada", "p\\"ass")');
		expect(code).toContain("auth=auth,");
	});
});

/**
 * The file-reference edges: a value the *shell* hands over byte for byte can
 * still be read by the client as a path.
 *
 * Quoting cannot help here - the bytes arrive intact and the client interprets
 * them. curl's `-F` reads a value starting with `@` or `<` as a file to upload
 * and `;type=` as a per-part override; HTTPie's item grammar reads `=@` the
 * same way, `==` as a query parameter, and a `:`/`@` in the key as a header or
 * a file upload. So the fix is the flag and the escape, and these cases decode
 * what the *client* will parse rather than the bytes we chose to write.
 */

/** The generated curl command's arguments, one per continuation line. */
function curlArgs(code: string): string[] {
	return code.split("\\\n").map((line) => line.trim());
}

/** The decoded `key=value` pairs curl receives for one flag. */
function curlPairs(code: string, flag: string): Array<[string, string]> {
	return curlArgs(code)
		.filter((arg) => arg.startsWith(`${flag} `))
		.map((arg): [string, string] => {
			const decoded = unquoteShell(arg.slice(flag.length + 1));
			const split = decoded.indexOf("=");
			return [decoded.slice(0, split), decoded.slice(split + 1)];
		});
}

/**
 * The request items of a generated HTTPie command, unquoted from the shell.
 *
 * An item is a bare quoted word, which a header is too - so the requests below
 * carry no headers, and the URL sits on the first line beside `http METHOD`.
 */
function httpieItems(code: string): string[] {
	return code
		.split("\\\n")
		.map((line) => line.trim())
		.filter((arg) => arg.startsWith("'"))
		.map(unquoteShell);
}

/**
 * Parse an HTTPie request item the way HTTPie does.
 *
 * A backslash escapes the character after it when that character is special,
 * and the separator is then the *earliest* one still standing, longest first at
 * that position. Returning the separator is the point: an item that parses with
 * `=@` instead of `=` is a file read, and one that parses with `==` is a query
 * parameter, both with a perfectly innocent-looking key and value.
 */
function parseHttpieItem(item: string): { key: string; value: string; separator: string } {
	const special = new Set(["\\", ":", "=", "@"]);
	const characters: Array<{ char: string; escaped: boolean }> = [];
	for (let i = 0; i < item.length; i++) {
		if (item[i] === "\\" && special.has(item[i + 1] ?? "")) {
			characters.push({ char: item[i + 1], escaped: true });
			i++;
		} else {
			characters.push({ char: item[i], escaped: false });
		}
	}
	// An escaped character occupies one position in both strings, so an index
	// found in `visible` addresses `literal` unchanged.
	const visible = characters.map((c) => (c.escaped ? "\u0000" : c.char)).join("");
	const literal = characters.map((c) => c.char).join("");

	let at = -1;
	let separator = "";
	for (const candidate of [":=@", "=@", ":=", "==", "=", ":", "@"]) {
		const index = visible.indexOf(candidate);
		if (index === -1) continue;
		if (at === -1 || index < at || (index === at && candidate.length > separator.length)) {
			at = index;
			separator = candidate;
		}
	}
	if (at === -1) throw new Error(`no separator in item: ${item}`);
	return { key: literal.slice(0, at), value: literal.slice(at + separator.length), separator };
}

describe("a form value is never read as a local file", () => {
	const FILE_REFERENCE_VALUES: Array<[string, string]> = [
		["a leading @", "@/etc/passwd"],
		["a leading <", "</etc/passwd"],
		["a ;type= override", "report;type=text/html"],
		["a leading =", "=not-a-query-parameter"],
	];

	for (const [name, value] of FILE_REFERENCE_VALUES) {
		it(`curl sends ${name} as data`, () => {
			const { code } = generateCurl({
				...GET,
				method: "POST",
				body: { mode: "form-data", fields: [{ key: "field", value }] },
			});
			expect(curlArgs(code).some((arg) => arg.startsWith("-F "))).toBe(false);
			expect(curlPairs(code, "--form-string")).toEqual([["field", value]]);
		});

		it(`HTTPie sends ${name} as data`, () => {
			const { code } = generateHttpie({
				...GET,
				method: "POST",
				body: { mode: "form-data", fields: [{ key: "field", value }] },
			});
			expect(parseHttpieItem(httpieItems(code)[0])).toEqual({
				key: "field",
				value,
				separator: "=",
			});
		});
	}

	const HOSTILE_KEYS: Array<[string, string]> = [
		["a space", "field name"],
		["an ampersand", "a&b"],
		["an equals sign", "a=b"],
		["an at sign", "user@host"],
	];

	for (const [name, key] of HOSTILE_KEYS) {
		it(`curl encodes a urlencoded key containing ${name}`, () => {
			const { code } = generateCurl({
				...GET,
				method: "POST",
				body: { mode: "x-www-form-urlencoded", fields: [{ key, value: "v" }] },
			});
			const [[emittedKey, emittedValue]] = curlPairs(code, "--data-urlencode");
			// curl encodes only what follows the first `=`, so any of these surviving
			// raw in the name is the bug: `&` starts a second field, `@` is curl's
			// `name@file` file read, and a space is simply a different name. `=` needs
			// no case of its own - raw, it *is* the split, so the decode below fails.
			expect(emittedKey).not.toMatch(/[ &@]/);
			expect(decodeURIComponent(emittedKey)).toBe(key);
			expect(emittedValue).toBe("v");
		});

		it(`HTTPie escapes a form key containing ${name}`, () => {
			const { code } = generateHttpie({
				...GET,
				method: "POST",
				body: { mode: "x-www-form-urlencoded", fields: [{ key, value: "v" }] },
			});
			expect(parseHttpieItem(httpieItems(code)[0])).toEqual({
				key,
				value: "v",
				separator: "=",
			});
		});
	}

	it("HTTPie keeps a backslash instead of letting it escape the next character", () => {
		const { code } = generateHttpie({
			...GET,
			method: "POST",
			body: { mode: "form-data", fields: [{ key: "path", value: String.raw`C:\=temp` }] },
		});
		expect(parseHttpieItem(httpieItems(code)[0])).toEqual({
			key: "path",
			value: String.raw`C:\=temp`,
			separator: "=",
		});
	});

	it("PowerShell says -Form needs 6.1+, and says it only where -Form is used", () => {
		const multipart = generatePowerShell({
			...GET,
			method: "POST",
			body: { mode: "form-data", fields: [{ key: "a", value: "b" }] },
		});
		// Atop the snippet: Windows PowerShell 5.1 has no `-Form` at all, and it is
		// the shell whose `curl` alias is why this target exists.
		expect(multipart.code.startsWith("# requires PowerShell 6.1+ (-Form)")).toBe(true);
		expect(multipart.code).toContain("-Form $body");

		const urlencoded = generatePowerShell({
			...GET,
			method: "POST",
			body: { mode: "x-www-form-urlencoded", fields: [{ key: "a", value: "b" }] },
		});
		expect(urlencoded.code).not.toContain("6.1+");
	});
});

describe("every target, on the shared rules", () => {
	const request: SnippetRequest = {
		method: "POST",
		url: "https://api.example.com/v1/users?token=s3cret",
		headers: { "X-Auth": "s3cret" },
		body: { mode: "json", content: '{"key":"s3cret"}' },
		auth: { mode: "bearer", token: "s3cret" },
	};

	for (const target of CODE_TARGETS) {
		it(`${target.label} masks every secret when asked`, () => {
			const { code, masked } = target.generate(request, { secrets: ["s3cret"], mask: true });
			// Masking lives in `prepare.ts`, so a target that reached around it -
			// reading `request` instead of the prepared shape - leaks here and only
			// here.
			expect(code).not.toContain("s3cret");
			expect(code).toContain(SECRET_PLACEHOLDER);
			expect(masked).toBe(true);
		});

		it(`${target.label} carries the note for an auth mode it cannot reproduce`, () => {
			const { notes } = target.generate({ ...GET, auth: { mode: "aws", config: {} } });
			expect(notes.join(" ")).toContain("AWS Signature");
		});

		it(`${target.label} applies bearer auth rather than dropping it`, () => {
			const { code } = target.generate({ ...GET, auth: { mode: "bearer", token: "t0ken" } });
			expect(code).toContain("Authorization");
			expect(code).toContain("Bearer t0ken");
		});
	}
});

describe("the target registry", () => {
	it("dispatches by id", () => {
		expect(generateSnippet("curl", GET).code).toBe(generateCurl(GET).code);
		expect(generateSnippet("fetch", GET).code).toBe(generateFetch(GET).code);
		expect(generateSnippet("httpie", GET).code).toBe(generateHttpie(GET).code);
		expect(generateSnippet("python", GET).code).toBe(generatePython(GET).code);
		expect(generateSnippet("powershell", GET).code).toBe(generatePowerShell(GET).code);
	});

	it("throws on an unknown target rather than guessing a language", () => {
		expect(() => generateSnippet("ruby" as (typeof CODE_TARGETS)[number]["id"], GET)).toThrow(
			/Unknown code target/
		);
	});

	it("every registered target generates something for a bare GET", () => {
		expect(CODE_TARGETS.length).toBeGreaterThan(0);
		for (const target of CODE_TARGETS) {
			expect(target.generate(GET).code.length).toBeGreaterThan(0);
		}
	});

	it("gives every target a unique id and a label", () => {
		const ids = CODE_TARGETS.map((t) => t.id);
		// The id is what the section's Select persists in component state and
		// what `generateSnippet` dispatches on; a duplicate would silently
		// shadow one target with another.
		expect(new Set(ids).size).toBe(ids.length);
		for (const target of CODE_TARGETS) {
			expect(target.label.length).toBeGreaterThan(0);
		}
	});
});

/**
 * A stream-flagged request (issue #575). Two targets have a first-class
 * unbuffered mode and emit it; the three whose stock idiom buffers the whole
 * body say so, because a snippet that looked like the request would hang on an
 * endless stream and a reader would blame the endpoint.
 */
describe("a streaming request", () => {
	const STREAM: SnippetRequest = {
		method: "GET",
		url: "https://api.example.com/events",
		headers: { Accept: "text/event-stream" },
		stream: true,
	};

	it("curl emits -N, and parseCurl reads it back as the same setting", () => {
		const { code } = generateCurl(STREAM);
		expect(code).toContain(" -N");
		// The round trip issue #575 asks for, asserted through the real parser
		// rather than by eye: a flag the generator emits and the importer skips
		// would pass a one-sided test.
		const reparsed = parseCommand(code.split("\\\n").join(" "));
		expect(reparsed?.stream).toBe(true);
	});

	it("curl does not duplicate an Accept the request already declares", () => {
		const { code } = generateCurl(STREAM);
		expect(code.match(/Accept: text\/event-stream/g)).toHaveLength(1);
	});

	it("curl adds the implied Accept when the request declares none", () => {
		const { code } = generateCurl({ ...STREAM, headers: {} });
		expect(code).toContain("Accept: text/event-stream");
	});

	it("curl leaves a differently-declared Accept alone", () => {
		const { code } = generateCurl({
			...STREAM,
			headers: { Accept: "application/stream+json" },
		});
		expect(code).toContain("application/stream+json");
		expect(code).not.toContain("Accept: text/event-stream");
	});

	it("HTTPie emits its own --stream", () => {
		expect(generateHttpie(STREAM).code).toContain("--stream");
	});

	it("the buffering targets say they buffer, rather than emitting a command that hangs", () => {
		for (const generate of [generateFetch, generatePython, generatePowerShell]) {
			const { notes } = generate(STREAM);
			expect(notes.some((n) => n.includes("event stream"))).toBe(true);
		}
	});

	it("nothing changes for a request that is not a stream", () => {
		const plain: SnippetRequest = { ...STREAM, stream: false };
		expect(generateCurl(plain).code).not.toContain(" -N");
		expect(generateHttpie(plain).code).not.toContain("--stream");
		for (const generate of [generateFetch, generatePython, generatePowerShell]) {
			expect(generate(plain).notes.some((n) => n.includes("event stream"))).toBe(false);
		}
	});
});

/**
 * The Content-Type a body mode implies (issue #580, the rider #585 deferred here).
 *
 * Every content mode fell through `normalizeBody` as raw content with **no**
 * header, so a copied curl of a GraphQL or JSON-RPC request went out under
 * libcurl's `x-www-form-urlencoded` default and most servers answered 400 - the
 * snippet not doing what the app had just done, which is the one thing it is
 * for. The table mirrors the engine's `implied_content_type`.
 *
 * Asserted across every target rather than on curl alone: the rule lives in
 * `prepare.ts`, so a target that stopped emitting prepared headers would be the
 * failure this catches.
 */
describe("the Content-Type a body mode implies", () => {
	const withBody = (mode: string, content: string): SnippetRequest => ({
		...GET,
		method: "POST",
		body: { mode, content },
	});

	const CASES = [
		["graphql", '{"query":"{ hero { name } }"}', "application/json"],
		["jsonrpc", '{"method":"eth_blockNumber","params":[]}', "application/json"],
		["xml", "<soap:Envelope><soap:Body/></soap:Envelope>", "application/xml"],
	] as const;

	for (const [mode, content, expected] of CASES) {
		it(`sends a ${mode} body as ${expected} in every target`, () => {
			for (const target of CODE_TARGETS) {
				const { code } = target.generate(withBody(mode, content));
				expect(code, `${target.id} lost the header`).toContain(expected);
			}
		});
	}

	// The user-wins rule, the same one the engine (`body_content_type_header`)
	// and the request builder (`body/content-type.ts`) apply. SOAP 1.2 requires
	// `application/soap+xml`, so overwriting it would break the audience the xml
	// mode exists for.
	it("keeps a declared Content-Type instead of replacing it", () => {
		const { code } = generateCurl({
			...withBody("xml", "<a/>"),
			headers: { "Content-Type": "application/soap+xml" },
		});
		expect(code).toContain("application/soap+xml");
		expect(code).not.toContain("application/xml");
	});

	it("recognises a declared header whatever its casing", () => {
		const { code } = generateCurl({
			...withBody("xml", "<a/>"),
			headers: { "content-type": "text/xml" },
		});
		expect(code).toContain("text/xml");
		expect(code).not.toContain("application/xml");
	});

	// `json` and `text` are the modes a user writes the header for themselves,
	// and the engine derives nothing for them either. Emitting one here would be
	// the app inventing a request the user did not describe.
	it.each(["json", "text"])("adds nothing for a %s body", (mode) => {
		const { code } = generateCurl(withBody(mode, '{"a":1}'));
		expect(code).not.toContain("Content-Type");
	});

	// An empty body is not a body: `has_wire_body` is false engine-side, so no
	// header is sent, and a snippet that declared one would describe a request
	// nothing makes.
	it("adds nothing when the mode carries no content", () => {
		const { code } = generateCurl(withBody("xml", ""));
		expect(code).not.toContain("application/xml");
	});
});
