/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test } from "vitest";
import { DROPPED_FLAG_INFO, detectCommand, importCommand, parseCommand } from "./parseCurl";

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

describe("parseCommand - curl", () => {
	test("simple GET", () => {
		const r = parseCommand("curl https://api.example.com/users")!;
		expect(r.method).toBe("GET");
		expect(r.url).toBe("https://api.example.com/users");
		expect(r.bodyMode).toBe("none");
		expect(r.auth).toEqual({ mode: "none" });
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
		// A raw, non-form blob with no Content-Type stays a text body.
		expect(r.bodyMode).toBe("text");
		expect(r.body).toBe("hello");
	});

	test("form-shaped -d without Content-Type → urlencoded rows (curl default)", () => {
		const r = parseCommand(`curl https://x.com -d 'a=1' -d 'b=2'`)!;
		expect(r.method).toBe("POST");
		expect(r.bodyMode).toBe("x-www-form-urlencoded");
		expect(r.urlEncoded).toEqual(
			kv([
				{ key: "a", value: "1" },
				{ key: "b", value: "2" },
			])
		);
	});

	test("JSON blob via -d without Content-Type stays text (not mangled into rows)", () => {
		const r = parseCommand(`curl https://x.com -d '{"a":1}'`)!;
		expect(r.bodyMode).toBe("text");
		expect(r.body).toBe('{"a":1}');
	});

	test("OAuth2 token-endpoint curl imports as urlencoded form fields", () => {
		const r = parseCommand(
			`curl -s http://localhost:9099/default/token -d grant_type=password ` +
				`-d client_id=my-client -d client_secret=my-secret -d username=alice ` +
				`-d password=whatever -d scope=openid`
		)!;
		expect(r.method).toBe("POST");
		expect(r.url).toBe("http://localhost:9099/default/token");
		expect(r.bodyMode).toBe("x-www-form-urlencoded");
		expect(r.urlEncoded).toEqual(
			kv([
				{ key: "grant_type", value: "password" },
				{ key: "client_id", value: "my-client" },
				{ key: "client_secret", value: "my-secret" },
				{ key: "username", value: "alice" },
				{ key: "password", value: "whatever" },
				{ key: "scope", value: "openid" },
			])
		);
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

	test("-F form data, with a file part", () => {
		const r = parseCommand(`curl https://x.com -F 'name=joe' -F 'avatar=@/tmp/pic.png'`)!;
		expect(r.method).toBe("POST");
		expect(r.bodyMode).toBe("form-data");
		// The file row is the half issue #393 added: before it, `avatar` imported
		// as a text field whose value was the literal "@/tmp/pic.png".
		expect(r.formData.map(({ id: _id, ...row }) => row)).toEqual([
			{ key: "name", value: "joe", enabled: true },
			{
				key: "avatar",
				value: "",
				enabled: true,
				type: "file",
				src: "/tmp/pic.png",
				fileName: "pic.png",
				unresolved: true,
			},
		]);
	});

	test("-F reads curl's per-part type and filename modifiers", () => {
		const r = parseCommand(
			`curl https://x.com -F 'dataset=@/tmp/a.bin;type=text/csv;filename=people.csv'`
		)!;
		expect(r.formData.map(({ id: _id, ...row }) => row)).toEqual([
			{
				key: "dataset",
				value: "",
				enabled: true,
				type: "file",
				src: "/tmp/a.bin",
				fileName: "people.csv",
				contentType: "text/csv",
				unresolved: true,
			},
		]);
	});

	test("--form-string keeps a leading @ as text", () => {
		// The flag exists precisely so `@` is not a file reference, and Vayu's own
		// curl snippet emits it for every text part - so this is the round trip.
		const r = parseCommand(`curl https://x.com --form-string 'handle=@ada'`)!;
		expect(r.bodyMode).toBe("form-data");
		expect(r.formData.map(({ id: _id, ...row }) => row)).toEqual([
			{ key: "handle", value: "@ada", enabled: true },
		]);
	});

	test("-u basic auth", () => {
		const r = parseCommand(`curl https://x.com -u 'admin:secret'`)!;
		expect(r.auth).toEqual({ mode: "basic", username: "admin", password: "secret" });
	});

	test("--oauth2-bearer → bearer auth", () => {
		const r = parseCommand(`curl https://x.com --oauth2-bearer 'tok-123'`)!;
		expect(r.auth).toEqual({ mode: "bearer", token: "tok-123" });
		// The flag maps to typed auth, not a raw header.
		expect(r.headers).toEqual([]);
	});

	test("--oauth2-bearer=token inline form, preserves {{variables}}", () => {
		const r = parseCommand(`curl https://x.com --oauth2-bearer={{token}}`)!;
		expect(r.auth).toEqual({ mode: "bearer", token: "{{token}}" });
	});

	test("--oauth2-bearer wins over -u", () => {
		const r = parseCommand(`curl https://x.com -u 'a:b' --oauth2-bearer 'tok'`)!;
		expect(r.auth).toEqual({ mode: "bearer", token: "tok" });
	});

	test("-I → HEAD", () => {
		const r = parseCommand(`curl -I https://x.com`)!;
		expect(r.method).toBe("HEAD");
	});

	test("-T implies PUT (file path discarded)", () => {
		const r = parseCommand(`curl -T upload.bin https://x.com`)!;
		expect(r.method).toBe("PUT");
		expect(r.url).toBe("https://x.com");
		expect(r.bodyMode).toBe("none");
	});

	test("explicit -X overrides -T's PUT inference", () => {
		const r = parseCommand(`curl -T upload.bin -X PATCH https://x.com`)!;
		expect(r.method).toBe("PATCH");
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

describe("parseCommand - wget", () => {
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
		expect(r.auth).toEqual({ mode: "basic", username: "admin", password: "secret" });
	});

	test("--post-file is skipped (not mapped to form-data)", () => {
		const r = parseCommand(`wget --post-file=body.txt https://x.com`)!;
		expect(r.bodyMode).toBe("none");
		expect(r.method).toBe("GET");
		expect(r.url).toBe("https://x.com");
	});
});

describe("parseCommand - failure modes", () => {
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
			auth: { mode: "none" },
		});
	});
});

/**
 * `-k` / `--insecure` says the host's certificate does not verify, which is a
 * property of the request rather than an output nicety - so it maps onto the
 * stored `verifySSL` instead of being skipped (issue #706). A command that
 * turned verification off, imported as a verifying request, fails on its first
 * send for the reason the command already named. `codegen.test.ts` holds the
 * other half of the round trip.
 */
describe("parseCommand - curl -k is the verifySSL setting", () => {
	test.each([["-k"], ["--insecure"]])("%s turns verification off", (flag) => {
		const parsed = parseCommand(`curl ${flag} https://internal.example.com/health`);
		expect(parsed?.verifySSL).toBe(false);
	});

	test("a command without it verifies, which is curl's own default", () => {
		const parsed = parseCommand("curl https://api.example.com/health");
		expect(parsed?.verifySSL).toBe(true);
	});

	test("wget's spelling of the same intent is honoured too", () => {
		const parsed = parseCommand(
			"wget --no-check-certificate https://internal.example.com/health"
		);
		expect(parsed?.verifySSL).toBe(false);
	});

	test("the flag is not mistaken for a value-taking one", () => {
		// `-k` used to sit in the no-argument skip set; a mapping that consumed
		// the next token instead would eat the URL and the parse would return
		// null.
		const parsed = parseCommand("curl -k -X POST https://internal.example.com/orders");
		expect(parsed?.url).toBe("https://internal.example.com/orders");
		expect(parsed?.method).toBe("POST");
	});
});

/**
 * `-N` / `--no-buffer` is how a stream is consumed from a terminal, so it maps
 * onto the request's Event stream setting rather than being skipped as an
 * output nicety (issue #575). The generator emits it back, and
 * `codegen.test.ts` holds that half of the round trip.
 */
describe("parseCommand - curl -N is the stream setting", () => {
	test.each([["-N"], ["--no-buffer"]])("%s turns the stream on", (flag) => {
		const parsed = parseCommand(`curl ${flag} https://api.example.com/events`);
		expect(parsed?.stream).toBe(true);
	});

	test("a command without it leaves the stream off", () => {
		const parsed = parseCommand("curl https://api.example.com/events");
		expect(parsed?.stream).toBe(false);
	});

	test("the Accept the setting implies is added when the command declares none", () => {
		const parsed = parseCommand("curl -N https://api.example.com/events");
		expect(parsed?.headers).toEqual(kv([{ key: "Accept", value: "text/event-stream" }]));
	});

	test("a declared Accept is the author's and is never overridden", () => {
		const parsed = parseCommand(
			"curl -N -H 'Accept: application/stream+json' https://api.example.com/events"
		);
		expect(parsed?.headers).toEqual(kv([{ key: "Accept", value: "application/stream+json" }]));
	});

	test("an Accept already naming the stream type is not duplicated", () => {
		const parsed = parseCommand(
			"curl --no-buffer -H 'accept: text/event-stream' https://api.example.com/events"
		);
		expect(parsed?.headers).toHaveLength(1);
	});

	test("a POST body still imports beside the flag", () => {
		const parsed = parseCommand(
			`curl -N -X POST -H 'Content-Type: application/json' -d '{"since":1}' https://api.example.com/events`
		);
		expect(parsed?.stream).toBe(true);
		expect(parsed?.method).toBe("POST");
		expect(parsed?.bodyMode).toBe("json");
		expect(parsed?.body).toBe('{"since":1}');
	});
});

/**
 * The disclosure ledger (issue #708).
 *
 * curl paste is the one import path that ate what it could not map and said
 * nothing. What is asserted here is not a list of flags - it is the property
 * that makes the list maintainable: the ledger is derived from the skip sets,
 * so a flag that gets *mapped* leaves the ledger on its own.
 */
describe("what a paste could not carry", () => {
	test("names the flags with no home in the request, and where their intent lives", () => {
		const imported = importCommand(
			"curl -k -x http://corp:8080 --cert c.pem https://api.example.com/"
		);
		const dropped = imported?.dropped ?? [];

		expect(dropped.map((entry) => entry.flag).sort()).toEqual(["--cert", "-x"]);
		expect(dropped.find((entry) => entry.flag === "-x")?.pointer).toEqual({
			category: "network_performance",
			anchor: "proxyUrl",
			label: "Proxy settings",
		});
		expect(dropped.find((entry) => entry.flag === "--cert")?.pointer?.anchor).toBe(
			"clientCertificates"
		);
	});

	test("the import itself is untouched by what it disclosed", () => {
		// The ledger says what was lost; it must never cost anything that was
		// not. `-k` in the same command is *mapped*, and stays mapped.
		const imported = importCommand("curl -k -x http://corp:8080 https://api.example.com/pets");

		expect(imported?.request.url).toBe("https://api.example.com/pets");
		expect(imported?.request.verifySSL).toBe(false);
	});

	test("a mapped flag is absent from the ledger", () => {
		// `-k` is in neither skip set any more (issue #706 mapped it), so it
		// cannot be disclosed - this is the automatic-drop property stated as a
		// test. Reverting #706's mapping would put `-k` back in a skip set and
		// redden this.
		const imported = importCommand("curl -k https://api.example.com/");
		expect(imported?.dropped).toEqual([]);
	});

	test("a command that carried everything discloses nothing", () => {
		// The common paste. A notice on every one of them is how a disclosure
		// surface gets learned as noise.
		const imported = importCommand("curl -H 'X-Key: v' https://api.example.com/");
		expect(imported?.dropped).toEqual([]);
	});

	test("the same flag twice is one entry", () => {
		const imported = importCommand("curl -x http://a:1 -x http://b:2 https://api.example.com/");
		expect(imported?.dropped).toHaveLength(1);
	});

	test("a skipped --flag=value does not swallow the URL after it", () => {
		// The inline form carries its own value, so consuming the next token
		// ate whatever followed - which is the URL on nearly every real command,
		// and the whole paste then imported as nothing. Reverting the guard in
		// the two skip branches reddens both of these.
		expect(
			importCommand("curl --proxy=http://corp:8080 https://api.example.com/pets")?.request.url
		).toBe("https://api.example.com/pets");
		expect(importCommand("wget --tries=3 https://api.example.com/pets")?.request.url).toBe(
			"https://api.example.com/pets"
		);
	});

	test("wget's own skipped flags are disclosed too", () => {
		// Two commands, one request shape - so honouring the discipline on one
		// path and not the other is exactly the drift this parser avoids.
		const imported = importCommand("wget --tries=3 https://api.example.com/");
		expect(imported?.dropped.map((entry) => entry.flag)).toEqual(["--tries"]);
	});
});

test("every described flag is still one a parser skips", () => {
	// The other direction of the derivation: an entry left in the description
	// table after its flag was mapped is unreachable, and unreachable text is
	// how a table drifts into describing behaviour that no longer exists.
	// Checked against both commands, because the two disagree about several
	// short flags (`-T` uploads for curl and times out for wget).
	for (const flag of Object.keys(DROPPED_FLAG_INFO)) {
		const seen = [
			...(importCommand(`curl ${flag} value https://api.example.com/`)?.dropped ?? []),
			...(importCommand(`wget ${flag} value https://api.example.com/`)?.dropped ?? []),
		].map((entry) => entry.flag);
		expect(seen, `${flag} is described but no longer skipped`).toContain(flag);
	}
});
