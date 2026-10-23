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
 * that the cached form is the same answer as the plain one. A request flagged
 * `runsPreRequestScript` (#2741) keeps its scope names written and still
 * generates `{{$dynamic}}` ones, as compose does.
 *
 * Mutation check: make `resolveSends` always use the caller's `resolve` and
 * the flagged cases fail (the stored value is drawn); drop `scripted` from
 * `sendsInput` and the cache-input case fails.
 */

import { describe, it, expect } from "vitest";
import type { KeyValueEntry } from "@/types";
import { resolveSendsUrl, sendsCacheInput, sendsResolver } from "./sends-url";

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

describe("a request a pre-request script runs before", () => {
	const flagged = (...args: Parameters<typeof sends>) => ({
		...sends(...args),
		runsPreRequestScript: true,
	});

	it("keeps a scope's {{name}} written in the URL, path and path row value", () => {
		const request = flagged("https://{{host}}/users/:name/{{seg}}", [
			pathRow("name", "{{tail}}"),
		]);
		expect(resolveSendsUrl(request, resolve)).toBe("https://{{host}}/users/{{tail}}/{{seg}}");
	});

	it("still generates a {{$dynamic}} name", () => {
		const out = resolveSendsUrl(flagged("https://{{host}}/n/{{$randomInt}}"), resolve);
		expect(out.startsWith("https://{{host}}/n/")).toBe(true);
		expect(out.slice("https://{{host}}/n/".length)).toMatch(/^\d+$/);
	});

	it("leaves an unknown {{$name}} written, as the preview always has", () => {
		expect(resolveSendsUrl(flagged("https://x/{{$noSuchThing}}"), resolve)).toBe(
			"https://x/{{$noSuchThing}}"
		);
	});

	it.each([[false], [undefined]])("is the stored-scope line when the flag is %s", (flag) => {
		const request = { ...sends("https://{{host}}/users/{{seg}}"), runsPreRequestScript: flag };
		expect(resolveSendsUrl(request, resolve)).toBe("https://api.test/users/a%20b");
	});

	it("answers the same through the cached resolver", () => {
		const request = flagged("https://{{host}}/u/{{$randomInt}}");
		const out = sendsResolver(resolve)(sendsCacheInput(request));
		expect(out.startsWith("https://{{host}}/u/")).toBe(true);
		expect(out.slice("https://{{host}}/u/".length)).toMatch(/^\d+$/);
	});
});

describe("sendsCacheInput", () => {
	const base = sends("https://api.test/users/:name", [pathRow("name", "ada")]);

	it("changes with each member the URL depends on", () => {
		const input = sendsCacheInput(base);
		expect(sendsCacheInput({ ...base, url: "https://api.test/u/:name" })).not.toBe(input);
		expect(sendsCacheInput({ ...base, params: [pathRow("name", "bob")] })).not.toBe(input);
		expect(sendsCacheInput({ ...base, disableUrlEncoding: true })).not.toBe(input);
		// A stable cache serves the last line while this text is unchanged, so
		// toggling the flag has to change it.
		expect(sendsCacheInput({ ...base, runsPreRequestScript: true })).not.toBe(input);
	});

	it("reads an absent flag as an unset one", () => {
		expect(sendsCacheInput({ ...base, runsPreRequestScript: false })).toBe(
			sendsCacheInput(base)
		);
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

	it("is one wrapper per resolver, so a cache comparing resolvers by identity holds", () => {
		const other = (text: string) => resolve(text);
		expect(sendsResolver(resolve)).toBe(sendsResolver(resolve));
		expect(sendsResolver(other)).not.toBe(sendsResolver(resolve));
	});
});
