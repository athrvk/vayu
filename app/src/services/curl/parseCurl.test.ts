/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test } from "vitest";
import { detectCommand, parseCommand } from "./parseCurl";

const kv = (items: Array<{ key: string; value: string }>) =>
	items.map((i) => expect.objectContaining({ ...i, enabled: true }));

describe("detectCommand", () => {
	test.each([
		["curl https://x.com", "curl"],
		["wget https://x.com", "wget"],
		["  curl https://x.com", "curl"],
		["$ curl https://x.com", "curl"],
		["CURL https://x.com", "curl"],
	])("detects %s", (input, expected) => {
		expect(detectCommand(input)).toBe(expected);
	});

	test.each([
		"https://x.com",
		"https://x.com?a={{b}}",
		"",
		"curlsomething https://x.com",
		"echo hi",
	])("rejects %s", (input) => {
		expect(detectCommand(input)).toBeNull();
	});
});

describe("parseCommand — curl", () => {
	test("simple GET", () => {
		const r = parseCommand("curl https://api.example.com/users")!;
		expect(r.method).toBe("GET");
		expect(r.url).toBe("https://api.example.com/users");
		expect(r.bodyMode).toBe("none");
		expect(r.authType).toBe("none");
		expect(r.headers).toEqual([]);
	});

	test("headers", () => {
		const r = parseCommand(
			`curl https://x.com -H 'Accept: application/json' -H 'X-Token: abc'`
		)!;
		expect(r.headers).toEqual(
			kv([
				{ key: "Accept", value: "application/json" },
				{ key: "X-Token", value: "abc" },
			])
		);
	});

	test("POST with JSON data + content-type → json body", () => {
		const r = parseCommand(
			`curl -X POST https://x.com -H 'Content-Type: application/json' -d '{"a":1}'`
		)!;
		expect(r.method).toBe("POST");
		expect(r.bodyMode).toBe("json");
		expect(r.body).toBe('{"a":1}');
	});

	test("data without explicit method implies POST", () => {
		const r = parseCommand(`curl https://x.com -d 'hello'`)!;
		expect(r.method).toBe("POST");
		expect(r.bodyMode).toBe("text");
		expect(r.body).toBe("hello");
	});

	test("--json shortcut sets headers + json mode", () => {
		const r = parseCommand(`curl https://x.com --json '{"a":1}'`)!;
		expect(r.method).toBe("POST");
		expect(r.bodyMode).toBe("json");
		expect(r.body).toBe('{"a":1}');
		expect(r.headers).toEqual(
			kv([
				{ key: "Content-Type", value: "application/json" },
				{ key: "Accept", value: "application/json" },
			])
		);
	});

	test("urlencoded content-type → urlEncoded rows", () => {
		const r = parseCommand(
			`curl -X POST https://x.com -H 'Content-Type: application/x-www-form-urlencoded' -d 'a=1&b=2'`
		)!;
		expect(r.bodyMode).toBe("x-www-form-urlencoded");
		expect(r.urlEncoded).toEqual(
			kv([
				{ key: "a", value: "1" },
				{ key: "b", value: "2" },
			])
		);
	});

	test("--data-urlencode", () => {
		const r = parseCommand(`curl https://x.com --data-urlencode 'q=hello world'`)!;
		expect(r.bodyMode).toBe("x-www-form-urlencoded");
		expect(r.urlEncoded).toEqual(kv([{ key: "q", value: "hello world" }]));
	});

	test("-G moves data to query params and forces GET", () => {
		const r = parseCommand(`curl -G https://x.com -d 'a=1' -d 'b=2'`)!;
		expect(r.method).toBe("GET");
		expect(r.url).toBe("https://x.com?a=1&b=2");
		expect(r.bodyMode).toBe("none");
		expect(r.params).toEqual(
			kv([
				{ key: "a", value: "1" },
				{ key: "b", value: "2" },
			])
		);
	});

	test("-F form data, skipping file uploads", () => {
		const r = parseCommand(`curl https://x.com -F 'name=joe' -F 'avatar=@pic.png'`)!;
		expect(r.method).toBe("POST");
		expect(r.bodyMode).toBe("form-data");
		expect(r.formData).toEqual(kv([{ key: "name", value: "joe" }]));
	});

	test("-u basic auth", () => {
		const r = parseCommand(`curl https://x.com -u 'admin:secret'`)!;
		expect(r.authType).toBe("basic");
		expect(r.authConfig.basic).toEqual({ username: "admin", password: "secret" });
	});

	test("-I → HEAD", () => {
		const r = parseCommand(`curl -I https://x.com`)!;
		expect(r.method).toBe("HEAD");
	});

	test("-d @file is skipped", () => {
		const r = parseCommand(`curl -X POST https://x.com -d @body.json`)!;
		expect(r.method).toBe("POST");
		expect(r.body).toBe("");
		expect(r.bodyMode).toBe("none");
	});

	test("query string in URL is mirrored to params", () => {
		const r = parseCommand(`curl 'https://x.com/s?a=1&b=2'`)!;
		expect(r.params).toEqual(
			kv([
				{ key: "a", value: "1" },
				{ key: "b", value: "2" },
			])
		);
	});

	test("ignored flags don't swallow the URL", () => {
		const r = parseCommand(`curl -sL --compressed -o out.txt https://x.com`)!;
		expect(r.url).toBe("https://x.com");
	});

	test("--header=value inline form", () => {
		const r = parseCommand(`curl https://x.com --header='X-A: 1'`)!;
		expect(r.headers).toEqual(kv([{ key: "X-A", value: "1" }]));
	});

	test("real multi-line Chrome copy-as-cURL (bash)", () => {
		const cmd = `curl 'https://api.example.com/v1/items?page=2' \\
  -H 'authority: api.example.com' \\
  -H 'accept: application/json' \\
  --data-raw '{"name":"widget"}' \\
  --compressed`;
		const r = parseCommand(cmd)!;
		expect(r.method).toBe("POST");
		expect(r.url).toBe("https://api.example.com/v1/items?page=2");
		expect(r.params).toEqual(kv([{ key: "page", value: "2" }]));
		expect(r.body).toBe('{"name":"widget"}');
	});

	test("cmd ^ continuation variant", () => {
		const cmd = `curl ^\n  "https://x.com" ^\n  -H "Accept: application/json"`;
		const r = parseCommand(cmd)!;
		expect(r.url).toBe("https://x.com");
		expect(r.headers).toEqual(kv([{ key: "Accept", value: "application/json" }]));
	});

	test("preserves {{variables}}", () => {
		const r = parseCommand(`curl 'https://x.com/{{id}}' -H 'Authorization: Bearer {{token}}'`)!;
		expect(r.url).toBe("https://x.com/{{id}}");
		expect(r.headers).toEqual(kv([{ key: "Authorization", value: "Bearer {{token}}" }]));
	});
});

describe("parseCommand — wget", () => {
	test("simple GET", () => {
		const r = parseCommand("wget https://x.com")!;
		expect(r.method).toBe("GET");
		expect(r.url).toBe("https://x.com");
	});

	test("--method + --header + --post-data", () => {
		const r = parseCommand(
			`wget --method=PUT --header='Content-Type: application/json' --body-data='{"a":1}' https://x.com`
		)!;
		expect(r.method).toBe("PUT");
		expect(r.bodyMode).toBe("json");
		expect(r.body).toBe('{"a":1}');
		expect(r.headers).toEqual(kv([{ key: "Content-Type", value: "application/json" }]));
	});

	test("--post-data implies POST", () => {
		const r = parseCommand(`wget --post-data='a=1&b=2' https://x.com`)!;
		expect(r.method).toBe("POST");
	});

	test.each([
		`wget --user=admin --password=secret https://x.com`,
		`wget --password=secret --user=admin https://x.com`,
	])("user/password order-independent: %s", (cmd) => {
		const r = parseCommand(cmd)!;
		expect(r.authType).toBe("basic");
		expect(r.authConfig.basic).toEqual({ username: "admin", password: "secret" });
	});

	test("--post-file is skipped (not mapped to form-data)", () => {
		const r = parseCommand(`wget --post-file=body.txt https://x.com`)!;
		expect(r.bodyMode).toBe("none");
		expect(r.method).toBe("GET");
		expect(r.url).toBe("https://x.com");
	});
});

describe("parseCommand — failure modes", () => {
	test.each(["https://x.com", "", "not a command", `curl -d 'unterminated`])(
		"returns null for %s",
		(input) => {
			expect(parseCommand(input)).toBeNull();
		}
	);

	test("curl with no URL returns null", () => {
		expect(parseCommand("curl -X POST -H 'A: 1'")).toBeNull();
	});

	test("complete-shape reset: every request field is present", () => {
		const r = parseCommand("curl https://x.com")!;
		expect(r).toMatchObject({
			method: "GET",
			url: "https://x.com",
			params: [],
			headers: [],
			bodyMode: "none",
			body: "",
			formData: [],
			urlEncoded: [],
			authType: "none",
			authConfig: {},
		});
	});
});
