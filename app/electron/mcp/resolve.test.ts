/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test } from "vitest";
import {
	buildVariableMap,
	makeResolver,
	buildCollectionChain,
	composeAuth,
	composeScripts,
	resolveHeaders,
	resolveBody,
	composeSavedRequest,
	type CollectionLike,
} from "./resolve.js";

const enabled = (value: string) => ({ value, enabled: true });

describe("variable resolution", () => {
	test("precedence: environment > collection chain (leaf) > globals", () => {
		const chain: CollectionLike[] = [
			{ id: "root", variables: { a: enabled("root-a"), b: enabled("root-b") } },
			{ id: "leaf", variables: { b: enabled("leaf-b") } },
		];
		const map = buildVariableMap({
			globals: { a: enabled("glob-a"), c: enabled("glob-c") },
			chain,
			environment: { a: enabled("env-a") },
		});
		expect(map.get("a")).toBe("env-a"); // environment wins
		expect(map.get("b")).toBe("leaf-b"); // leaf collection over root
		expect(map.get("c")).toBe("glob-c"); // globals fill the gap
	});

	test("disabled variables are ignored", () => {
		const map = buildVariableMap({ globals: { a: { value: "x", enabled: false } } });
		expect(map.has("a")).toBe(false);
	});

	test("unknown variables resolve to empty string (renderer parity)", () => {
		const { resolveString } = makeResolver(new Map([["known", "K"]]));
		expect(resolveString("{{known}}/{{missing}}")).toBe("K/");
	});

	test("resolveObject recurses through nested structures", () => {
		const { resolveObject } = makeResolver(new Map([["t", "TOK"]]));
		expect(resolveObject({ a: "{{t}}", b: { c: ["{{t}}", 1, true] } })).toEqual({
			a: "TOK",
			b: { c: ["TOK", 1, true] },
		});
	});
});

describe("collection chain", () => {
	const collections: CollectionLike[] = [
		{ id: "root", parentId: null },
		{ id: "mid", parentId: "root" },
		{ id: "leaf", parentId: "mid" },
	];

	test("returns the root-first inclusive ancestor chain", () => {
		expect(buildCollectionChain("leaf", collections).map((c) => c.id)).toEqual([
			"root",
			"mid",
			"leaf",
		]);
	});

	test("is cycle-safe on a corrupted parent link", () => {
		const cyclic: CollectionLike[] = [
			{ id: "a", parentId: "b" },
			{ id: "b", parentId: "a" },
		];
		const ids = buildCollectionChain("a", cyclic).map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length); // no infinite loop, no dupes
	});

	test("empty for a missing start id", () => {
		expect(buildCollectionChain(undefined, collections)).toEqual([]);
	});
});

describe("auth composition", () => {
	const resolver = makeResolver(new Map([["token", "T"]]));

	test("inherit walks the chain leaf→root and takes the first concrete auth", () => {
		const chain: CollectionLike[] = [
			{ id: "root", auth: { mode: "bearer", token: "root-tok" } },
			{ id: "leaf", auth: { mode: "basic", username: "u", password: "p" } },
		];
		expect(composeAuth({ mode: "inherit" }, chain, resolver)).toEqual({
			mode: "basic",
			username: "u",
			password: "p",
		});
	});

	test("inherit skips 'none' collections and resolves variables in the chosen block", () => {
		const chain: CollectionLike[] = [
			{ id: "root", auth: { mode: "bearer", token: "{{token}}" } },
			{ id: "leaf", auth: { mode: "none" } },
		];
		expect(composeAuth({ mode: "inherit" }, chain, resolver)).toEqual({
			mode: "bearer",
			token: "T",
		});
	});

	test("a missing auth field defaults to inherit", () => {
		const chain: CollectionLike[] = [
			{ id: "root", auth: { mode: "bearer", token: "{{token}}" } },
		];
		expect(composeAuth(undefined, chain, resolver)).toEqual({ mode: "bearer", token: "T" });
	});

	test("concrete auth is resolved and passed through; 'none' becomes undefined", () => {
		expect(composeAuth({ mode: "bearer", token: "{{token}}" }, [], resolver)).toEqual({
			mode: "bearer",
			token: "T",
		});
		expect(composeAuth({ mode: "none" }, [], resolver)).toBeUndefined();
		expect(composeAuth({ mode: "inherit" }, [], resolver)).toBeUndefined();
	});

	test("oauth2: nested config {{vars}} deep-resolve; non-string fields survive", () => {
		const r = makeResolver(
			new Map([
				["cid", "client-1"],
				["secret", "sh-h-h"],
				["tokenUrl", "https://auth.example.com/token"],
			])
		);
		// The engine mints the token from this config; MCP's job is only to forward
		// a fully variable-resolved oauth2 block. Booleans/scopes must pass through.
		expect(
			composeAuth(
				{
					mode: "oauth2",
					config: {
						grantType: "client_credentials",
						clientId: "{{cid}}",
						clientSecret: "{{secret}}",
						tokenUrl: "{{tokenUrl}}",
						scope: "read {{cid}}",
						autoFetchToken: true,
						tokenPlacement: "header",
					},
				},
				[],
				r
			)
		).toEqual({
			mode: "oauth2",
			config: {
				grantType: "client_credentials",
				clientId: "client-1",
				clientSecret: "sh-h-h",
				tokenUrl: "https://auth.example.com/token",
				scope: "read client-1",
				autoFetchToken: true,
				tokenPlacement: "header",
			},
		});
	});

	test("oauth2 via inherit: a collection's oauth2 block is chosen and resolved", () => {
		const r = makeResolver(new Map([["secret", "sh-h-h"]]));
		const chain: CollectionLike[] = [
			{ id: "c1", auth: { mode: "oauth2", config: { clientSecret: "{{secret}}" } } },
		];
		expect(composeAuth({ mode: "inherit" }, chain, r)).toEqual({
			mode: "oauth2",
			config: { clientSecret: "sh-h-h" },
		});
	});
});

describe("script composition", () => {
	test("chain scripts (root→leaf) precede the request's own, blank-line joined", () => {
		const chain: CollectionLike[] = [
			{ id: "root", preRequestScript: "root-pre", postRequestScript: "root-post" },
			{ id: "leaf", preRequestScript: "leaf-pre", postRequestScript: "" },
		];
		const out = composeScripts(
			{ preRequestScript: "req-pre", postRequestScript: "req-post" },
			chain
		);
		expect(out.preRequestScript).toBe("root-pre\n\nleaf-pre\n\nreq-pre");
		expect(out.postRequestScript).toBe("root-post\n\nreq-post");
	});

	test("no scripts anywhere yields undefined (not an empty string)", () => {
		expect(composeScripts({}, [])).toEqual({
			preRequestScript: undefined,
			postRequestScript: undefined,
		});
	});
});

describe("headers & body", () => {
	const resolver = makeResolver(new Map([["v", "V"]]));

	test("headers flatten to an object map, drop disabled rows, resolve values", () => {
		expect(
			resolveHeaders(
				[
					{ key: "A", value: "{{v}}", enabled: true },
					{ key: "B", value: "b", enabled: false },
					{ key: "C", value: "c" },
				],
				resolver
			)
		).toEqual({ A: "V", C: "c" });
	});

	test("body preserves its mode and resolves content", () => {
		expect(resolveBody({ mode: "json", content: '{"k":"{{v}}"}' }, resolver)).toEqual({
			mode: "json",
			content: '{"k":"V"}',
		});
		expect(resolveBody({ mode: "none" }, resolver)).toBeUndefined();
	});
});

describe("composeSavedRequest", () => {
	test("produces the full outgoing payload the engine executes", () => {
		const resolver = makeResolver(
			new Map([
				["host", "api.example.com"],
				["token", "T"],
			])
		);
		const chain: CollectionLike[] = [
			{ id: "c1", auth: { mode: "bearer", token: "{{token}}" }, preRequestScript: "pre" },
		];
		const out = composeSavedRequest(
			{
				id: "r1",
				method: "post",
				url: "https://{{host}}/x",
				headers: [{ key: "Accept", value: "application/json", enabled: true }],
				body: { mode: "json", content: '{"a":1}' },
				postRequestScript: "post",
			},
			chain,
			resolver,
			"env_1"
		);
		expect(out).toEqual({
			method: "POST",
			url: "https://api.example.com/x",
			headers: { Accept: "application/json" },
			body: { mode: "json", content: '{"a":1}' },
			auth: { mode: "bearer", token: "T" },
			preRequestScript: "pre",
			postRequestScript: "post",
			followRedirects: true,
			maxRedirects: 10,
			requestId: "r1",
			environmentId: "env_1",
		});
	});
});

/*
 * The renderer sends `followRedirects` / `maxRedirects` on every execute (see
 * `request-builder/index.tsx` handleExecute). MCP must too: the engine defaults
 * `follow_redirects` to true, so a request that opted out of following would
 * have its 3xx followed anyway if the field were merely omitted.
 */
describe("redirect policy parity with the renderer", () => {
	const resolver = makeResolver(new Map());

	test("forwards a stored non-default policy", () => {
		const out = composeSavedRequest(
			{ method: "GET", url: "https://x/y", followRedirects: false, maxRedirects: 3 },
			[],
			resolver
		);
		expect(out.followRedirects).toBe(false);
		expect(out.maxRedirects).toBe(3);
	});

	test("a row saved before the columns existed reads as the engine default", () => {
		const out = composeSavedRequest({ method: "GET", url: "https://x/y" }, [], resolver);
		expect(out.followRedirects).toBe(true);
		expect(out.maxRedirects).toBe(10);
	});

	test("sends the fields even when they match the default", () => {
		// Omitting them would let the engine default win, which is the same
		// value today but silently re-couples the app to the engine's choice.
		const out = composeSavedRequest(
			{ method: "GET", url: "https://x/y", followRedirects: true, maxRedirects: 10 },
			[],
			resolver
		);
		expect(Object.keys(out)).toContain("followRedirects");
		expect(Object.keys(out)).toContain("maxRedirects");
	});

	test("clamps an out-of-range or non-numeric maxRedirects like the renderer", () => {
		const high = composeSavedRequest(
			{ method: "GET", url: "https://x/y", maxRedirects: 5000 },
			[],
			resolver
		);
		expect(high.maxRedirects).toBe(100);

		const negative = composeSavedRequest(
			{ method: "GET", url: "https://x/y", maxRedirects: -4 },
			[],
			resolver
		);
		expect(negative.maxRedirects).toBe(0);

		const junk = composeSavedRequest(
			// A corrupted row: the field is present but not a number.
			{ method: "GET", url: "https://x/y", maxRedirects: Number.NaN },
			[],
			resolver
		);
		expect(junk.maxRedirects).toBe(10);
	});
});
