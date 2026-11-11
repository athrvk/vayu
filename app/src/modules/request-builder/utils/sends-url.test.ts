/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The URL the "Sends" line and the tab title share (#2637). What each rule
 * writes is `path-variables.test.ts`'s and `query-encoding.test.ts`'s claim;
 * this pins the composition - path rows first, then the URL's own tokens - and
 * that the cached form is the same answer as the plain one.
 */

import { describe, it, expect, vi } from "vitest";
import type { DataFieldContext } from "@/lib/data-bind-escaping";
import { previewRowBind } from "@/lib/variable-resolution";
import type { Collection, KeyValueEntry, RequestAuth } from "@/types";
import { deferredNamesIn } from "@/lib/deferred-note";
import { resolveAuthForSend } from "./auth-resolution";
import {
	deferredNamesInSends,
	leaveDeferredField,
	resolveSendsUrl,
	sendsCacheInput,
	sendsHasTokens,
	sendsResolver,
} from "./sends-url";

const VARIABLES: Record<string, string> = { seg: "a b", host: "api.test", tail: "x?y" };
const resolverFor = (vars: Record<string, string>) => (text: string) =>
	Object.entries(vars).reduce((out, [name, value]) => out.split(`{{${name}}}`).join(value), text);
const resolve = resolverFor(VARIABLES);

const pathRow = (key: string, value: string, enabled = true): KeyValueEntry => ({
	key,
	value,
	enabled,
	in: "path",
});
const queryRow = (key: string, value: string): KeyValueEntry => ({ key, value, enabled: true });

const sends = (
	url: string,
	params: KeyValueEntry[] = [],
	disableUrlEncoding = false
): Parameters<typeof resolveSendsUrl>[0] => ({ url, params, disableUrlEncoding });

describe("resolveSendsUrl", () => {
	it("writes a variable resolving to `a b` into the path encoded", () => {
		expect(resolveSendsUrl(sends("https://{{host}}/users/{{seg}}"), resolve)).toBe(
			"https://api.test/users/a%20b"
		);
	});

	it("leaves it as typed under disableUrlEncoding", () => {
		expect(resolveSendsUrl(sends("https://{{host}}/users/{{seg}}", [], true), resolve)).toBe(
			"https://api.test/users/a b"
		);
	});

	it("fills a `:name` segment from its path row, resolved then encoded", () => {
		const request = sends("https://api.test/users/:name", [pathRow("name", "{{tail}}")]);
		expect(resolveSendsUrl(request, resolve)).toBe("https://api.test/users/x%3Fy");
	});

	it("fills it raw under disableUrlEncoding", () => {
		const request = sends("https://api.test/users/:name", [pathRow("name", "{{seg}}")], true);
		expect(resolveSendsUrl(request, resolve)).toBe("https://api.test/users/a b");
	});

	it("runs the path rows before the URL's own tokens", () => {
		// A `{{host}}` holding a `:` must not be read as a `:name` segment.
		const withPort = resolverFor({ ...VARIABLES, host: "api.test:8080" });
		const request = sends("https://{{host}}/users/:name", [pathRow("name", "{{seg}}")]);
		expect(resolveSendsUrl(request, withPort)).toBe("https://api.test:8080/users/a%20b");
	});

	it("leaves a segment whose row is disabled or empty as written", () => {
		expect(
			resolveSendsUrl(
				sends("https://api.test/:a/:b", [pathRow("a", "1", false), pathRow("b", "")]),
				resolve
			)
		).toBe("https://api.test/:a/:b");
	});

	it("takes query rows from the URL, never from the rows", () => {
		const request = sends("https://api.test/users?page=1", [queryRow("page", "2")]);
		expect(resolveSendsUrl(request, resolve)).toBe("https://api.test/users?page=1");
	});
});

describe("resolveSendsUrl, the URL that reaches the server (#3425)", () => {
	const withUrl = (url: string, disableUrlEncoding = false) =>
		resolveSendsUrl(sends(url, [], disableUrlEncoding), resolve);

	describe.each([
		["encoded", false],
		["as typed", true],
	])("%s", (_mode, disableUrlEncoding) => {
		it("cuts the fragment, which libcurl never sends", () => {
			expect(withUrl("https://api.test/p?x=1#frag", disableUrlEncoding)).toBe(
				"https://api.test/p?x=1"
			);
			expect(withUrl("https://api.test/p#", disableUrlEncoding)).toBe("https://api.test/p");
		});

		it("cuts a fragment a variable's value brings", () => {
			const brings = resolverFor({ frag: "#x" });
			expect(
				resolveSendsUrl(sends("https://api.test/p{{frag}}", [], disableUrlEncoding), brings)
			).toBe("https://api.test/p");
		});

		it("does not read a # inside a {{token}} as the fragment", () => {
			const named = resolverFor({ "a#b": "v" });
			const request = sends("https://api.test/{{a#b}}?q=1#f", [], disableUrlEncoding);
			expect(resolveSendsUrl(request, named)).toBe("https://api.test/v?q=1");
			// Left written (a deferred name), the token is still not a fragment.
			expect(resolveSendsUrl(request, named, ["a#b"])).toBe("https://api.test/{{a#b}}?q=1");
		});
	});

	describe("an API key placed in the query", () => {
		const apiKey = (
			key: string,
			value: string,
			where: "query" | "header" = "query"
		): RequestAuth => ({ mode: "apikey", key, value, in: where });
		const sendsWith = (
			url: string,
			auth: Record<string, unknown> | undefined,
			disableUrlEncoding = false
		) => resolveSendsUrl({ ...sends(url, [], disableUrlEncoding), auth }, resolve);
		const record = (auth: RequestAuth) => auth as unknown as Record<string, unknown>;

		it("is appended encoded, with or without a query already there", () => {
			const auth = record(apiKey("api_key", "s3cr et&x"));
			expect(sendsWith("https://api.test/p", auth)).toBe(
				"https://api.test/p?api_key=s3cr%20et%26x"
			);
			expect(sendsWith("https://api.test/p?a=1", auth)).toBe(
				"https://api.test/p?a=1&api_key=s3cr%20et%26x"
			);
		});

		it("is appended where the fragment was cut, not after it", () => {
			expect(sendsWith("https://api.test/p#frag", record(apiKey("k", "v")))).toBe(
				"https://api.test/p?k=v"
			);
		});

		it("is written as typed under disableUrlEncoding", () => {
			expect(sendsWith("https://api.test/p", record(apiKey("k 1", "s3cr et&x")), true)).toBe(
				"https://api.test/p?k 1=s3cr et&x"
			);
		});

		it("is trimmed, writes `key=` for an empty value and nothing for an empty key", () => {
			expect(sendsWith("https://api.test/p", record(apiKey(" k ", "\tv ")))).toBe(
				"https://api.test/p?k=v"
			);
			expect(sendsWith("https://api.test/p", record(apiKey("k", "")))).toBe(
				"https://api.test/p?k="
			);
			expect(sendsWith("https://api.test/p", record(apiKey("  ", "v")))).toBe(
				"https://api.test/p"
			);
		});

		it("cuts a `#` typed in the key or value under disableUrlEncoding, as libcurl does", () => {
			expect(sendsWith("https://api.test/p", record(apiKey("k", "a#b")), true)).toBe(
				"https://api.test/p?k=a"
			);
			expect(sendsWith("https://api.test/p?x=1", record(apiKey("k#1", "v")), true)).toBe(
				"https://api.test/p?x=1&k"
			);
			// Encoded, the `#` is `%23` and stays.
			expect(sendsWith("https://api.test/p", record(apiKey("k", "a#b")))).toBe(
				"https://api.test/p?k=a%23b"
			);
		});

		it("leaves a request with no URL with no URL", () => {
			expect(sendsWith("", record(apiKey("k", "v")))).toBe("");
		});

		it("is not appended when it goes in a header, or for any other mode", () => {
			const url = "https://api.test/p";
			expect(sendsWith(url, record(apiKey("k", "v", "header")))).toBe(url);
			for (const auth of [
				undefined,
				{ mode: "none" },
				{ mode: "noauth" },
				{ mode: "bearer", token: "t" },
				{ mode: "oauth2", config: {} },
				{ mode: "inherit" },
			]) {
				expect(sendsWith(url, auth)).toBe(url);
			}
		});

		it("is the one an `inherit` request gets from its chain", () => {
			const folder = {
				id: "f",
				auth: apiKey("k", "inherited"),
			} as unknown as Collection;
			const inherited = resolveAuthForSend({ mode: "inherit" }, [folder]);
			expect(sendsWith("https://api.test/p", inherited)).toBe(
				"https://api.test/p?k=inherited"
			);
			expect(
				sendsWith("https://api.test/p", resolveAuthForSend({ mode: "inherit" }, []))
			).toBe("https://api.test/p");
		});

		it("resolves a {{token}} in its name and value, and leaves a deferred one written", () => {
			const auth = record(apiKey("{{host}}", "{{seg}}"));
			const request = { ...sends("https://api.test/p"), auth };
			expect(resolveSendsUrl(request, resolve)).toBe("https://api.test/p?api.test=a%20b");
			expect(resolveSendsUrl(request, resolve, ["seg"])).toBe(
				"https://api.test/p?api.test={{seg}}"
			);
		});
	});
});

describe("resolveSendsUrl, an OAuth 2.0 token placed in the query (#3437)", () => {
	const oauth2 = (config: Record<string, unknown>): Record<string, unknown> => ({
		mode: "oauth2",
		config,
	});
	const resolved = (
		url: string,
		auth: Record<string, unknown> | undefined,
		disableUrlEncoding = false
	) => sendsResolver(resolve)(sendsCacheInput({ ...sends(url, [], disableUrlEncoding), auth }));
	const queried = (config: Record<string, unknown> = {}) =>
		oauth2({ tokenPlacement: "query", ...config });

	it("appends the engine's default name, `access_token`, with a stand-in for the token", () => {
		const { url, secret } = resolved("https://api.test/p", queried());
		expect(secret).not.toBeNull();
		expect(url).toBe(`https://api.test/p?access_token=${secret}`);
		expect(resolved("https://api.test/p?a=1", queried()).url).toBe(
			`https://api.test/p?a=1&access_token=${secret}`
		);
	});

	it("writes the stand-in as it is, whatever the encoding", () => {
		const encoded = resolved("https://api.test/p", queried());
		const raw = resolved("https://api.test/p", queried(), true);
		expect(raw).toEqual(encoded);
	});

	it("uses the configured name, resolved, and the default only when it is empty", () => {
		expect(resolved("https://api.test/p", queried({ queryParamName: "tok" })).url).toMatch(
			/^https:\/\/api\.test\/p\?tok=/
		);
		expect(resolved("https://api.test/p", queried({ queryParamName: "{{host}}" })).url).toMatch(
			/^https:\/\/api\.test\/p\?api\.test=/
		);
		expect(resolved("https://api.test/p", queried({ queryParamName: "" })).url).toMatch(
			/\?access_token=/
		);
		// Empty once resolved, which is when the engine reads it.
		const blank = sendsResolver(resolverFor({ blank: "" }));
		const request = {
			...sends("https://api.test/p"),
			auth: queried({ queryParamName: "{{blank}}" }),
		};
		expect(blank(sendsCacheInput(request)).url).toMatch(/\?access_token=/);
		expect(resolved("https://api.test/p", queried({ queryParamName: 7 })).url).toMatch(
			/\?access_token=/
		);
	});

	it("reads the nested config, never a flat field", () => {
		const flat = { mode: "oauth2", tokenPlacement: "query", queryParamName: "tok" };
		expect(resolved("https://api.test/p", flat).url).toBe("https://api.test/p");
	});

	it("is appended where the fragment was cut, not after it", () => {
		expect(resolved("https://api.test/p#frag", queried()).url).toMatch(
			/^https:\/\/api\.test\/p\?access_token=[^#]*$/
		);
	});

	it("leaves a request with no URL with no URL", () => {
		expect(resolved("", queried())).toEqual({ url: "", secret: null });
	});

	it("adds nothing for a header placement, an absent one or a config that is not one", () => {
		const url = "https://api.test/p";
		for (const auth of [
			oauth2({ tokenPlacement: "header", queryParamName: "tok" }),
			oauth2({ queryParamName: "tok" }),
			oauth2({}),
			{ mode: "oauth2" },
			{ mode: "oauth2", config: null },
			{ mode: "oauth2", config: "query" },
			{ mode: "bearer", config: { tokenPlacement: "query" } },
		]) {
			expect(resolved(url, auth)).toEqual({ url, secret: null });
		}
	});

	it("is the one an `inherit` request gets from its chain", () => {
		const folder = {
			id: "f",
			auth: { mode: "oauth2", config: { tokenPlacement: "query", queryParamName: "tok" } },
		} as unknown as Collection;
		const inherited = resolveAuthForSend({ mode: "inherit" }, [folder]);
		expect(resolved("https://api.test/p", inherited).url).toMatch(/\?tok=/);
	});

	it("leaves a deferred name in the parameter name written", () => {
		const request = {
			...sends("https://api.test/p"),
			auth: queried({ queryParamName: "{{seg}}" }),
		};
		expect(resolveSendsUrl(request, resolve, ["seg"])).toMatch(/\?\{\{seg\}\}=/);
	});
});

describe("resolveSendsUrl, a GraphQL GET (#3437)", () => {
	const graphql = (content: string) => ({ mode: "graphql", content });
	const getting = (
		url: string,
		content: string,
		extra: Partial<Parameters<typeof resolveSendsUrl>[0]> = {}
	): Parameters<typeof resolveSendsUrl>[0] => ({
		...sends(url),
		method: "GET",
		body: graphql(content),
		...extra,
	});

	it("sends a bare document as the `query` parameter, encoded as the engine does", () => {
		expect(resolveSendsUrl(getting("https://api.test/g", "{ me(id: 1) }"), resolve)).toBe(
			"https://api.test/g?query=%7B%20me%28id%3A%201%29%20%7D"
		);
	});

	it("sends an envelope as one parameter per member, in the author's order", () => {
		const envelope =
			'{"query":"query Q($id: ID!) { me }","variables":{"id":7},"operationName":"Q"}';
		expect(resolveSendsUrl(getting("https://api.test/g?a=1", envelope), resolve)).toBe(
			"https://api.test/g?a=1&query=query%20Q%28%24id%3A%20ID%21%29%20%7B%20me%20%7D" +
				"&variables=%7B%22id%22%3A7%7D&operationName=Q"
		);
	});

	it("reads the method in any case", () => {
		const request = getting("https://api.test/g", "{ me }", { method: "get" });
		expect(resolveSendsUrl(request, resolve)).toBe("https://api.test/g?query=%7B%20me%20%7D");
	});

	it("resolves a {{token}} in the document before it encodes it", () => {
		const request = getting("https://{{host}}/g", '{ user(name: "{{seg}}") }');
		expect(resolveSendsUrl(request, resolve)).toBe(
			"https://api.test/g?query=%7B%20user%28name%3A%20%22a%20b%22%29%20%7D"
		);
		// Encoded first, the token would be sent as its own spelling.
		expect(resolveSendsUrl(request, resolve)).not.toContain("%7B%7B");
	});

	it("resolves a {{token}} in an envelope's variables before the document is read", () => {
		const request = getting(
			"https://api.test/g",
			'{"query":"{ me }","variables":{"n":"{{seg}}"}}'
		);
		expect(resolveSendsUrl(request, resolve)).toBe(
			"https://api.test/g?query=%7B%20me%20%7D&variables=%7B%22n%22%3A%22a%20b%22%7D"
		);
	});

	it("keeps a deferred name written, encoded with the rest of the document", () => {
		const request = getting("https://api.test/g", "{ f(x: {{seg}}) }");
		expect(resolveSendsUrl(request, resolve, ["seg"])).toContain("%7B%7Bseg%7D%7D");
	});

	it("is the URL the engine sends under disableUrlEncoding too", () => {
		const request = getting("https://api.test/g", "{ me }", { disableUrlEncoding: true });
		expect(resolveSendsUrl(request, resolve)).toBe("https://api.test/g?query=%7B%20me%20%7D");
	});

	it("adds nothing for another method, another body mode, or an empty document", () => {
		const url = "https://api.test/g";
		for (const request of [
			getting(url, "{ me }", { method: "POST" }),
			getting(url, "{ me }", { method: "HEAD" }),
			getting(url, "{ me }", { method: undefined }),
			getting(url, "{ me }", { body: { mode: "json", content: "{ me }" } }),
			getting(url, "{ me }", { body: { mode: "none" } }),
			getting(url, "{ me }", { body: undefined }),
			getting(url, ""),
			getting(url, "{ me }", { method: "GET", body: { mode: "graphql" } }),
		]) {
			expect(resolveSendsUrl(request, resolve)).toBe(url);
		}
	});

	it("keeps the body where it is for a document the engine cannot carry in the URL", () => {
		const unsupported = '{"query":"{ me }","extra":1}';
		expect(resolveSendsUrl(getting("https://api.test/g", unsupported), resolve)).toBe(
			"https://api.test/g"
		);
	});

	it("is appended before the fragment, which is then cut", () => {
		expect(resolveSendsUrl(getting("https://api.test/g?a=1#top", "{ me }"), resolve)).toBe(
			"https://api.test/g?a=1&query=%7B%20me%20%7D"
		);
	});

	it("leaves a request with no URL with no URL", () => {
		expect(resolveSendsUrl(getting("", "{ me }"), resolve)).toBe("");
	});

	describe("beside the auth's query parameter", () => {
		it("comes after an API key, as the engine appends the auth first", () => {
			const request = getting("https://api.test/g", "{ me }", {
				auth: { mode: "apikey", key: "k", value: "v", in: "query" },
			});
			expect(resolveSendsUrl(request, resolve)).toBe(
				"https://api.test/g?k=v&query=%7B%20me%20%7D"
			);
		});

		it("comes after an OAuth 2.0 token", () => {
			const request = getting("https://api.test/g", "{ me }", {
				auth: {
					mode: "oauth2",
					config: { tokenPlacement: "query", queryParamName: "tok" },
				},
			});
			expect(resolveSendsUrl(request, resolve)).toMatch(
				/^https:\/\/api\.test\/g\?tok=[^&]+&query=%7B%20me%20%7D$/
			);
		});

		it("is cut with the rest of what a raw # in the key's value starts", () => {
			const request = getting("https://api.test/g", "{ me }", {
				disableUrlEncoding: true,
				auth: { mode: "apikey", key: "k", value: "a#b", in: "query" },
			});
			expect(resolveSendsUrl(request, resolve)).toBe(
				"https://api.test/g?k=a&query=%7B%20me%20%7D"
			);
		});

		it("leaves the secret the auth's, never the document's", () => {
			const request = getting("https://api.test/g", "{ me }", {
				auth: { mode: "apikey", key: "k", value: "v", in: "query" },
			});
			expect(sendsResolver(resolve)(sendsCacheInput(request)).secret).toBe("v");
			expect(
				sendsResolver(resolve)(sendsCacheInput(getting("https://api.test/g", "{ me }")))
					.secret
			).toBeNull();
		});
	});
});

describe("the secret a Sends resolution appends (#3425)", () => {
	const keyed = (key: string, value: string, url = "https://api.test/p") => ({
		...sends(url),
		auth: { mode: "apikey", key, value, in: "query" },
	});
	const secretOf = (
		request: ReturnType<typeof keyed>,
		vars: Record<string, string>,
		deferred: readonly string[] = []
	) => sendsResolver(resolverFor(vars))(sendsCacheInput(request, deferred)).secret;

	it("is the resolved, trimmed value, whatever the variable that held it", () => {
		expect(secretOf(keyed("k", "s3cr3t"), {})).toBe("s3cr3t");
		expect(secretOf(keyed("k", "{{apiKey}}"), { apiKey: "abc" })).toBe("abc");
		expect(secretOf(keyed("k", "pre-{{apiKey}}"), { apiKey: "abc" })).toBe("pre-abc");
		// A value the trim shortens: the text on the line is not the variable's.
		expect(secretOf(keyed("k", "{{apiKey}}"), { apiKey: "  abc \t" })).toBe("abc");
	});

	it("is the value that went onto the line, not a second resolution", () => {
		let calls = 0;
		const rolling = (text: string) => text.replace("{{$roll}}", () => `r${++calls}`);
		const resolved = sendsResolver(rolling)(sendsCacheInput(keyed("k", "{{$roll}}")));
		expect(resolved).toEqual({ url: "https://api.test/p?k=r1", secret: "r1" });
		expect(calls).toBe(1);
	});

	it("is null when no key is appended or its value is blank", () => {
		expect(secretOf(keyed("k", ""), {})).toBeNull();
		expect(secretOf(keyed("k", " {{blank}} "), { blank: "" })).toBeNull();
		expect(secretOf(keyed("  ", "v"), {})).toBeNull();
		expect(secretOf(keyed("{{blank}}", "v"), { blank: " " })).toBeNull();
		expect(secretOf(keyed("k", "v", ""), {})).toBeNull();
		expect(
			secretOf({ ...keyed("k", "v"), auth: { ...keyed("k", "v").auth, in: "header" } }, {})
		).toBeNull();
	});

	it("is null for a `{{token}}` nothing resolved, which goes out as written", () => {
		const request = keyed("k", "{{missing}}");
		expect(sendsResolver((text) => text)(sendsCacheInput(request))).toEqual({
			url: "https://api.test/p?k={{missing}}",
			secret: null,
		});
		expect(secretOf(keyed("k", " pre-{{missing}} "), {})).toBeNull();
		// A name a script defers stays written, so it is not a value either.
		expect(secretOf(keyed("k", "{{token}}"), { token: "stored" }, ["token"])).toBeNull();
	});

	it("is the value when a variable's own text looks like a token", () => {
		expect(secretOf(keyed("k", "{{apiKey}}"), { apiKey: "{{other}}" })).toBe("{{other}}");
	});
});

describe("resolveSendsUrl with names a pre-request script defers (#2741)", () => {
	// `token` has a stored value, which is exactly what must not be shown.
	const stored = resolverFor({ ...VARIABLES, token: "stored-token" });

	it("leaves a deferred name written and resolves the rest", () => {
		expect(resolveSendsUrl(sends("https://{{host}}/v1?t={{token}}"), stored, ["token"])).toBe(
			"https://api.test/v1?t={{token}}"
		);
	});

	it("leaves it written in the path, where encoding would otherwise reach it", () => {
		expect(resolveSendsUrl(sends("https://{{host}}/{{token}}/a b"), stored, ["token"])).toBe(
			"https://api.test/{{token}}/a%20b"
		);
	});

	it("leaves it written under disableUrlEncoding, which resolves the whole URL at once", () => {
		expect(
			resolveSendsUrl(sends("https://{{host}}/{{token}}?q={{seg}}", [], true), stored, [
				"token",
			])
		).toBe("https://api.test/{{token}}?q=a b");
	});

	it("leaves it written inside a path row's value, where the segment takes it whole", () => {
		const request = sends("https://api.test/users/:name", [pathRow("name", "{{token}}")]);
		expect(resolveSendsUrl(request, stored, ["token"])).toBe(
			"https://api.test/users/{{token}}"
		);
	});

	it("matches a name written with padding, as the resolvers read it", () => {
		expect(resolveSendsUrl(sends("https://api.test/{{ token }}"), stored, ["token"])).toBe(
			"https://api.test/{{ token }}"
		);
	});

	it("is the plain resolution when nothing is deferred", () => {
		const request = sends("https://{{host}}/{{token}}");
		expect(resolveSendsUrl(request, stored, [])).toBe(resolveSendsUrl(request, stored));
		expect(resolveSendsUrl(request, stored)).toBe("https://api.test/stored-token");
	});
});

describe("sendsHasTokens", () => {
	it("is false for a literal URL, the case that must not pay for a compose", () => {
		expect(sendsHasTokens(sends("https://api.test/users/:name?page=1"))).toBe(false);
	});

	it("is true for a token in the URL", () => {
		expect(sendsHasTokens(sends("https://{{host}}/"))).toBe(true);
	});

	it("is true for a token only an enabled path row holds", () => {
		const url = "https://api.test/users/:name";
		expect(sendsHasTokens(sends(url, [pathRow("name", "{{tail}}")]))).toBe(true);
		expect(sendsHasTokens(sends(url, [pathRow("name", "{{tail}}", false)]))).toBe(false);
	});

	it("is false for a path row whose `:name` the URL does not hold", () => {
		const request = sends("https://api.test/users/:name", [pathRow("stale", "{{tail}}")]);
		expect(sendsHasTokens(request)).toBe(false);
	});

	it("reads only the row that answers a name, the last enabled one", () => {
		const url = "https://api.test/users/:id";
		expect(sendsHasTokens(sends(url, [pathRow("id", "{{tail}}"), pathRow("id", "7")]))).toBe(
			false
		);
		expect(sendsHasTokens(sends(url, [pathRow("id", "7"), pathRow("id", "{{tail}}")]))).toBe(
			true
		);
	});
});

describe("sendsHasTokens and deferredNamesInSends read an API key placed in the query (#3425)", () => {
	const keyed = (key: string, value: string, where = "query") => ({
		...sends("https://api.test/p"),
		auth: { mode: "apikey", key, value, in: where },
	});

	it("sees a token in the key or the value", () => {
		expect(sendsHasTokens(keyed("k", "v"))).toBe(false);
		expect(sendsHasTokens(keyed("{{name}}", "v"))).toBe(true);
		expect(sendsHasTokens(keyed("k", "{{secret}}"))).toBe(true);
		expect(deferredNamesInSends(keyed("k", "{{token}}"), ["token", "other"])).toEqual([
			"token",
		]);
	});

	it("ignores a key with no name, which the engine writes nothing for", () => {
		expect(sendsHasTokens(keyed(" \t", "{{secret}}"))).toBe(false);
		expect(deferredNamesInSends(keyed("  ", "{{token}}"), ["token"])).toEqual([]);
		expect(sendsCacheInput(keyed("  ", "v"))).toBe(
			sendsCacheInput(sends("https://api.test/p"))
		);
	});

	it("ignores a key that is not appended", () => {
		expect(sendsHasTokens(keyed("k", "{{secret}}", "header"))).toBe(false);
		expect(deferredNamesInSends(keyed("k", "{{token}}", "header"), ["token"])).toEqual([]);
	});
});

describe("sendsHasTokens and deferredNamesInSends read the new members of the sent URL (#3437)", () => {
	const oauth2 = (config: Record<string, unknown>) => ({
		...sends("https://api.test/p"),
		auth: { mode: "oauth2", config },
	});
	const graphql = (content: string, method = "GET", mode = "graphql") => ({
		...sends("https://api.test/g"),
		method,
		body: { mode, content },
	});

	it("sees a token in an OAuth 2.0 query parameter's name, only where it is placed in the query", () => {
		const placed = oauth2({ tokenPlacement: "query", queryParamName: "{{name}}" });
		expect(sendsHasTokens(placed)).toBe(true);
		expect(deferredNamesInSends(placed, ["name", "other"])).toEqual(["name"]);
		const inHeader = oauth2({ tokenPlacement: "header", queryParamName: "{{name}}" });
		expect(sendsHasTokens(inHeader)).toBe(false);
		expect(deferredNamesInSends(inHeader, ["name"])).toEqual([]);
		expect(sendsHasTokens(oauth2({ tokenPlacement: "query", queryParamName: "tok" }))).toBe(
			false
		);
	});

	it("sees a token in a GraphQL GET's document, and in no other body", () => {
		expect(sendsHasTokens(graphql("{ f(x: {{v}}) }"))).toBe(true);
		expect(deferredNamesInSends(graphql("{ f(x: {{v}}) }"), ["v", "other"])).toEqual(["v"]);
		expect(sendsHasTokens(graphql("{ f }"))).toBe(false);
		expect(sendsHasTokens(graphql("{ f(x: {{v}}) }", "POST"))).toBe(false);
		expect(sendsHasTokens(graphql("{ f(x: {{v}}) }", "GET", "json"))).toBe(false);
		expect(deferredNamesInSends(graphql("{{v}}", "POST"), ["v"])).toEqual([]);
	});
});

describe("deferredNamesInSends", () => {
	it("keeps only the engine's names that the URL uses, once each, in order", () => {
		const request = sends("https://{{host}}/{{token}}?a={{token}}&b={{ other }}");
		expect(deferredNamesInSends(request, ["token", "other", "unused", "host"])).toEqual([
			"host",
			"token",
			"other",
		]);
	});

	it("finds a name in a path row's value", () => {
		const request = sends("https://api.test/:name", [pathRow("name", "{{token}}")]);
		expect(deferredNamesInSends(request, ["token"])).toEqual(["token"]);
	});

	it("ignores a row for a `:name` the URL does not hold", () => {
		const request = sends("https://api.test/users/:name", [pathRow("foo", "{{token}}")]);
		expect(deferredNamesInSends(request, ["token"])).toEqual([]);
	});

	it("ignores a row a later enabled row for the same name shadows", () => {
		const request = sends("https://api.test/users/:id", [
			pathRow("id", "{{token}}"),
			pathRow("id", "7"),
		]);
		expect(deferredNamesInSends(request, ["token"])).toEqual([]);
	});

	it("is empty when the engine deferred nothing, or nothing the URL uses", () => {
		const request = sends("https://{{host}}/");
		expect(deferredNamesInSends(request, [])).toEqual([]);
		expect(deferredNamesInSends(request, ["token"])).toEqual([]);
	});
});

describe("sendsCacheInput", () => {
	const base = sends("https://api.test/users/:name", [pathRow("name", "ada")]);

	it("changes with each member the URL depends on", () => {
		const input = sendsCacheInput(base);
		expect(sendsCacheInput({ ...base, url: "https://api.test/u/:name" })).not.toBe(input);
		expect(sendsCacheInput({ ...base, params: [pathRow("name", "bob")] })).not.toBe(input);
		expect(sendsCacheInput({ ...base, disableUrlEncoding: true })).not.toBe(input);
	});

	it("changes with the API key placed in the query, and only with that one", () => {
		const key = (k: string, v: string, where = "query") => ({
			...base,
			auth: { mode: "apikey", key: k, value: v, in: where },
		});
		const input = sendsCacheInput(key("k", "v"));
		expect(input).not.toBe(sendsCacheInput(base));
		expect(sendsCacheInput(key("k2", "v"))).not.toBe(input);
		expect(sendsCacheInput(key("k", "v2"))).not.toBe(input);
		// A header placement and another mode add nothing to the URL, so a change
		// to them must not re-resolve (a generator would reroll).
		expect(sendsCacheInput(key("k", "v", "header"))).toBe(sendsCacheInput(base));
		expect(sendsCacheInput({ ...base, auth: { mode: "bearer", token: "t" } })).toBe(
			sendsCacheInput(base)
		);
	});

	it("changes with an OAuth 2.0 token placed in the query, its name, and only with those", () => {
		const oauth2 = (config: Record<string, unknown>) => ({
			...base,
			auth: { mode: "oauth2", config },
		});
		const input = sendsCacheInput(oauth2({ tokenPlacement: "query" }));
		expect(input).not.toBe(sendsCacheInput(base));
		expect(sendsCacheInput(oauth2({ tokenPlacement: "query", queryParamName: "t" }))).not.toBe(
			input
		);
		// Placed in the header, or any other config member, adds nothing to the URL,
		// so a change to it must not re-resolve (a generator would reroll).
		expect(sendsCacheInput(oauth2({ tokenPlacement: "header", queryParamName: "t" }))).toBe(
			sendsCacheInput(base)
		);
		expect(sendsCacheInput(oauth2({ tokenPlacement: "query", scope: "a" }))).toBe(input);
	});

	it("changes with a GraphQL GET's document, and only for a GET with that body", () => {
		const body = (content: string, mode = "graphql") => ({ mode, content });
		const get = (content: string) => ({ ...base, method: "GET", body: body(content) });
		const input = sendsCacheInput(get("{ a }"));
		expect(input).not.toBe(sendsCacheInput(base));
		expect(sendsCacheInput(get("{ b }"))).not.toBe(input);
		// Anything else leaves the body in the request, so editing it must not
		// re-resolve the line.
		expect(sendsCacheInput({ ...get("{ a }"), method: "POST" })).toBe(sendsCacheInput(base));
		expect(sendsCacheInput({ ...get("{ a }"), body: body("{ a }", "json") })).toBe(
			sendsCacheInput(base)
		);
		expect(sendsCacheInput(get(""))).toBe(sendsCacheInput(base));
		expect(sendsCacheInput({ ...base, method: "GET", body: body("{ b }", "text") })).toBe(
			sendsCacheInput(base)
		);
	});

	it("changes with the deferred names, so a changed answer re-resolves", () => {
		expect(sendsCacheInput(base, ["token"])).not.toBe(sendsCacheInput(base));
		expect(sendsCacheInput(base, ["token"])).toBe(sendsCacheInput(base, ["token"]));
	});

	it("ignores what the URL does not depend on", () => {
		const input = sendsCacheInput(base);
		const noisy = [
			queryRow("page", "1"),
			{ ...pathRow("name", "ada"), id: "row-7" } as KeyValueEntry,
		];
		expect(sendsCacheInput({ ...base, params: noisy })).toBe(input);
	});
});

describe("sendsResolver", () => {
	it("answers what resolveSendsUrl does for the same request", () => {
		const request = sends("https://api.test/users/:name/{{seg}}", [
			pathRow("name", "{{tail}}"),
		]);
		expect(sendsResolver(resolve)(sendsCacheInput(request)).url).toBe(
			resolveSendsUrl(request, resolve)
		);
	});

	it("answers what resolveSendsUrl does for deferred names too", () => {
		const request = sends("https://{{host}}/{{seg}}");
		expect(sendsResolver(resolve)(sendsCacheInput(request, ["seg"])).url).toBe(
			resolveSendsUrl(request, resolve, ["seg"])
		);
		expect(resolveSendsUrl(request, resolve, ["seg"])).toBe("https://api.test/{{seg}}");
	});

	it("answers what resolveSendsUrl does for a query-placed API key", () => {
		const request = {
			...sends("https://{{host}}/p#f"),
			auth: { mode: "apikey", key: "k", value: "{{seg}}", in: "query" },
		};
		expect(sendsResolver(resolve)(sendsCacheInput(request, ["seg"])).url).toBe(
			resolveSendsUrl(request, resolve, ["seg"])
		);
		expect(sendsResolver(resolve)(sendsCacheInput(request)).url).toBe(
			"https://api.test/p?k=a%20b"
		);
	});

	it("answers what resolveSendsUrl does for an OAuth 2.0 token and a GraphQL GET", () => {
		const request = {
			...sends("https://{{host}}/g#f"),
			method: "GET",
			body: { mode: "graphql", content: '{ f(x: "{{seg}}") }' },
			auth: {
				mode: "oauth2",
				config: { tokenPlacement: "query", queryParamName: "{{host}}" },
			},
		};
		for (const deferred of [[], ["seg"]]) {
			expect(sendsResolver(resolve)(sendsCacheInput(request, deferred)).url).toBe(
				resolveSendsUrl(request, resolve, deferred)
			);
		}
		expect(sendsResolver(resolve)(sendsCacheInput(request)).url).toMatch(
			/^https:\/\/api\.test\/g\?api\.test=[^&]+&query=%7B%20f%28x%3A%20%22a%20b%22%29%20%7D$/
		);
	});

	it("is one wrapper per resolver, so a cache comparing resolvers by identity holds", () => {
		const other = (text: string) => resolve(text);
		expect(sendsResolver(resolve)).toBe(sendsResolver(resolve));
		expect(sendsResolver(other)).not.toBe(sendsResolver(resolve));
	});
});

describe("leaveDeferredField (#2762)", () => {
	const lookup = (name: string) => ({ host: "api.test", token: "stored-token" })[name];
	const stored = (input: string, context?: DataFieldContext) =>
		previewRowBind(input, lookup, new Map(), context);

	it("leaves a deferred name written and resolves the rest of the field", () => {
		const resolve = leaveDeferredField(stored, ["token"]);
		expect(resolve("https://{{host}}/{{token}}").text).toBe("https://api.test/{{token}}");
	});

	it("matches a name written with padding, as the resolvers read it", () => {
		const resolve = leaveDeferredField(stored, ["token"]);
		expect(resolve("{{ token }}|{{ host }}").text).toBe("{{ token }}|api.test");
	});

	it("is the resolver itself when nothing is deferred", () => {
		expect(leaveDeferredField(stored, [])).toBe(stored);
	});

	it("hands the field's context to the resolver and keeps its refusals", () => {
		const resolveField = vi.fn((input: string, _context?: DataFieldContext) => ({
			text: input,
			refusals: ["refused"],
		}));
		const bound = leaveDeferredField(resolveField, ["token"])("a {{token}}", "header");
		expect(resolveField).toHaveBeenCalledWith(expect.any(String), "header");
		expect(bound.refusals).toEqual(["refused"]);
	});

	it("hands a field with no deferred token to the resolver as typed", () => {
		const resolveField = vi.fn(stored);
		leaveDeferredField(resolveField, ["token"])("{{host}}", "json");
		expect(resolveField).toHaveBeenCalledWith("{{host}}", "json");
	});

	it("keeps every occurrence written, each in its own place", () => {
		const resolve = leaveDeferredField(stored, ["token", "host"]);
		expect(resolve("{{token}} {{host}} {{token}} {{other}}").text).toBe(
			"{{token}} {{host}} {{token}} {{other}}"
		);
	});

	describe("with a picked data row", () => {
		const row = new Map([["name", 'say "hi"']]);
		const bound = (input: string, context: DataFieldContext) =>
			leaveDeferredField((text, ctx) => previewRowBind(text, lookup, row, ctx), ["token"])(
				input,
				context
			);

		it("escapes a cell by what surrounds it, across a deferred token", () => {
			// The cell after the token sits inside the string the token is in.
			expect(bound('{"a":"{{token}} {{data.name}}"}', "json").text).toBe(
				'{"a":"{{token}} say \\"hi\\""}'
			);
		});

		it("escapes for XML and for a header the way the unwrapped resolver does", () => {
			const xml = '<a t="{{token}}">{{data.name}}</a>';
			expect(bound(xml, "xml").text).toBe('<a t="{{token}}">say "hi"</a>');
			const lineBreak = new Map([["name", "ok\r\nX: y"]]);
			const refused = leaveDeferredField(
				(text, ctx) => previewRowBind(text, lookup, lineBreak, ctx),
				["token"]
			)("{{token}} {{data.name}}", "header");
			expect(refused.text).toBe("{{token}} {{data.name}}");
			expect(refused.refusals).toHaveLength(1);
		});
	});

	it("is one wrapper per resolver and set of names", () => {
		const other = (input: string) => stored(input);
		expect(leaveDeferredField(stored, ["token"])).toBe(leaveDeferredField(stored, ["token"]));
		expect(leaveDeferredField(stored, ["token"])).not.toBe(
			leaveDeferredField(stored, ["token", "host"])
		);
		expect(leaveDeferredField(stored, ["token"])).not.toBe(
			leaveDeferredField(other, ["token"])
		);
	});
});

describe("deferredNamesIn", () => {
	it("keeps the names the texts use, once each, in order of first appearance", () => {
		expect(
			deferredNamesIn(["b", "a", "unused"], ["{{a}} {{b}}", "{{ a }}", "no token", "{{b}}"])
		).toEqual(["a", "b"]);
	});

	it("is empty when nothing is deferred or nothing deferred is used", () => {
		expect(deferredNamesIn([], ["{{a}}"])).toEqual([]);
		expect(deferredNamesIn(["a"], ["{{b}}", ""])).toEqual([]);
	});
});
