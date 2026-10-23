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
import type { KeyValueEntry } from "@/types";
import { deferredNamesIn } from "@/lib/deferred-note";
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
		expect(sendsResolver(resolve)(sendsCacheInput(request))).toBe(
			resolveSendsUrl(request, resolve)
		);
	});

	it("answers what resolveSendsUrl does for deferred names too", () => {
		const request = sends("https://{{host}}/{{seg}}");
		expect(sendsResolver(resolve)(sendsCacheInput(request, ["seg"]))).toBe(
			resolveSendsUrl(request, resolve, ["seg"])
		);
		expect(resolveSendsUrl(request, resolve, ["seg"])).toBe("https://api.test/{{seg}}");
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
