/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The JSON-RPC and GraphQL bodies a snippet sends, against the engine's rule
 * (`jsonrpc_wire_body`, `graphql_wire_body`). The expectations are written out
 * as the engine's `dump ()` spells them, because the point is the bytes: the
 * engine's own suites (`jsonrpc_body_test.cpp`, `graphql_body_test.cpp`) hold
 * the same cases from its side.
 */

import { describe, it, expect } from "vitest";
import { readCompactJson } from "./compact-json";
import {
	curlEscape,
	graphqlGetQuery,
	graphqlWireBody,
	jsonRpcWireBody,
	urlWithQuery,
	wireBodyContent,
} from "./wire-body";

describe("jsonRpcWireBody", () => {
	it("completes a bare call with the version and id after the author's members", () => {
		expect(jsonRpcWireBody('{"method":"m"}')).toBe('{"method":"m","jsonrpc":"2.0","id":1}');
		expect(jsonRpcWireBody('{"method":"sum","params":[1,2]}')).toBe(
			'{"method":"sum","params":[1,2],"jsonrpc":"2.0","id":1}'
		);
	});

	it("keeps the author's key order, params untouched in order", () => {
		expect(jsonRpcWireBody('{"params":{"b":1,"a":2},"method":"z"}')).toBe(
			'{"params":{"b":1,"a":2},"method":"z","jsonrpc":"2.0","id":1}'
		);
	});

	it("returns a call that declares a string jsonrpc as typed, whitespace included", () => {
		const envelope = '{"jsonrpc":"2.0","id":42,"method":"m","meta":{"trace":"on"}}';
		expect(jsonRpcWireBody(envelope)).toBe(envelope);
		const spaced = '  { "id": 7, "jsonrpc": "2.0", "method": "m" }  ';
		expect(jsonRpcWireBody(spaced)).toBe(spaced);
		const notification = '{"jsonrpc":"2.0","method":"notify"}';
		expect(jsonRpcWireBody(notification)).toBe(notification);
	});

	it("keeps an existing id, null included, and adds none to a version-only change", () => {
		expect(jsonRpcWireBody('{"id":42,"method":"m"}')).toBe(
			'{"id":42,"method":"m","jsonrpc":"2.0"}'
		);
		expect(jsonRpcWireBody('{"id":null,"method":"m"}')).toBe(
			'{"id":null,"method":"m","jsonrpc":"2.0"}'
		);
		expect(jsonRpcWireBody('{"id":"abc"}')).toBe('{"id":"abc","jsonrpc":"2.0"}');
	});

	it("overwrites a jsonrpc that is not a string, in the position it held", () => {
		expect(jsonRpcWireBody('{"jsonrpc":2.0,"id":9,"method":"m"}')).toBe(
			'{"jsonrpc":"2.0","id":9,"method":"m"}'
		);
	});

	it("returns a batch, a scalar, empty and unparseable content as typed", () => {
		const batch = '[{"jsonrpc":"2.0","id":1,"method":"a"},{"method":"b"}]';
		for (const content of [batch, "42", '"a string"', "null", "", '{"method":"m",}', "{"]) {
			expect(jsonRpcWireBody(content), content).toBe(content);
		}
	});

	// Unresolved text: the engine resolves `{{a}}` and only then completes the
	// call, so a token in value position must not stop the completion.
	// Mutation check: drop `templateTokens` in `jsonRpcWireBody` and each of
	// these comes back as typed.
	it("completes a call whose values are unquoted template tokens", () => {
		expect(jsonRpcWireBody('{"method":"sum","params":[{{a}},{{b}}]}')).toBe(
			'{"method":"sum","params":[{{a}},{{b}}],"jsonrpc":"2.0","id":1}'
		);
		expect(jsonRpcWireBody('{"method":"m","params":{{args}}}')).toBe(
			'{"method":"m","params":{{args}},"jsonrpc":"2.0","id":1}'
		);
		expect(jsonRpcWireBody('{ "method" : "m" , "id" : {{id}} }')).toBe(
			'{"method":"m","id":{{id}},"jsonrpc":"2.0"}'
		);
	});

	it("does not read a template token as a key or inside a number or string", () => {
		for (const content of [
			"{{{k}}:1}",
			'{"method":"m","params":[{{a}}5]}',
			'{"method":"m","params":[1{{a}}]}',
			'{"method":"m","params":[{{}}]}',
			'{"method":"m","params":[{{a]}',
			'{"method":"m","params":[{{{a}}}]}',
		]) {
			expect(jsonRpcWireBody(content), content).toBe(content);
		}
		expect(jsonRpcWireBody('{"method":"{{m}}"}')).toBe(
			'{"method":"{{m}}","jsonrpc":"2.0","id":1}'
		);
	});

	it("appends jsonrpc and id after the author's members", () => {
		expect(jsonRpcWireBody('{"method":"m","params":{"n":1}}')).toBe(
			'{"method":"m","params":{"n":1},"jsonrpc":"2.0","id":1}'
		);
	});

	// A JS object would hoist "1" to the front and a JS number would drop the
	// spelling; the engine's ordered_json does neither.
	it("keeps an integer-like key where the author put it", () => {
		expect(jsonRpcWireBody('{"b":1,"1":2,"a":3}')).toBe(
			'{"b":1,"1":2,"a":3,"jsonrpc":"2.0","id":1}'
		);
	});

	it("keeps a repeated key at its first position with its last value", () => {
		expect(jsonRpcWireBody('{"a":1,"b":2,"a":3}')).toBe('{"a":3,"b":2,"jsonrpc":"2.0","id":1}');
	});

	it("re-spells numbers as the engine's dump does", () => {
		const call = (params: string) => jsonRpcWireBody(`{"params":${params}}`);
		const tail = ',"jsonrpc":"2.0","id":1}';
		expect(call("[1.0,1e3,1E+3,0.5,-2.5e10]")).toBe(
			`{"params":[1.0,1000.0,1000.0,0.5,-25000000000.0]${tail}`
		);
		expect(call("[1e30,1e-5,1.5e-7,0.0001,0.00001234,1e15,1e16]")).toBe(
			`{"params":[1e+30,1e-05,1.5e-07,0.0001,1.234e-05,1e+15,1e+16]${tail}`
		);
		expect(call("[0.0,-0.0,-0,0]")).toBe(`{"params":[0.0,-0.0,0,0]${tail}`);
	});

	it("keeps a 64-bit integer exact and writes a larger one as a float", () => {
		const call = (params: string) => jsonRpcWireBody(`{"params":${params}}`);
		const tail = ',"jsonrpc":"2.0","id":1}';
		expect(call("[18446744073709551615,-9223372036854775808,9007199254740993]")).toBe(
			`{"params":[18446744073709551615,-9223372036854775808,9007199254740993]${tail}`
		);
		expect(call("[18446744073709551616,-9223372036854775809]")).toBe(
			`{"params":[1.8446744073709552e+19,-9.223372036854776e+18]${tail}`
		);
	});

	it("writes strings the way the engine does: minimal escapes, no ASCII folding", () => {
		const content = '{"s":"a\\u00e9\\/\\b\\f\\n\\r\\t\\u0001\\u007f\\"\\\\ \\ud83d\\ude00"}';
		expect(jsonRpcWireBody(content)).toBe(
			'{"s":"aé/\\b\\f\\n\\r\\t\\u0001\u007f\\"\\\\ \u{1f600}","jsonrpc":"2.0","id":1}'
		);
	});

	it("compacts whitespace in a call it completes", () => {
		expect(jsonRpcWireBody(' \n{ "method" : "m" , "params" : [ 1 , { } , [ ] ] }\t')).toBe(
			'{"method":"m","params":[1,{},[]],"jsonrpc":"2.0","id":1}'
		);
	});

	// nlohmann refuses what the reader refuses, so the call is sent as typed.
	it.each([
		["a number past the double range", '{"x":1e999}'],
		["a lone surrogate escape", '{"x":"\\ud800"}'],
		["a leading zero", '{"x":01}'],
		["a bare fraction", '{"x":.5}'],
		["a single-quoted string", "{'x':1}"],
		["NaN", '{"x":NaN}'],
		["trailing text", '{"x":1} {"y":2}'],
		["a bad escape", '{"x":"\\x"}'],
		["a raw control character in a string", '{"x":"a\tb"}'],
	])("returns %s as typed", (_name, content) => {
		expect(jsonRpcWireBody(content)).toBe(content);
	});

	// The engine bounds the parse at 128 levels and sends a deeper call as typed.
	it("completes a call nested at the engine's bound and not one past it", () => {
		const nested = (levels: number) =>
			`{"p":${"[".repeat(levels - 1)}${"]".repeat(levels - 1)}}`;
		expect(jsonRpcWireBody(nested(128))).toBe(
			`${nested(128).slice(0, -1)},"jsonrpc":"2.0","id":1}`
		);
		expect(jsonRpcWireBody(nested(129))).toBe(nested(129));
	});
});

describe("graphqlWireBody", () => {
	it("wraps a bare document as a query string", () => {
		expect(graphqlWireBody("{ hero { name } }")).toBe('{"query":"{ hero { name } }"}');
		expect(graphqlWireBody("query Q($id: ID!) {\n  user(id: $id) { name }\n}")).toBe(
			'{"query":"query Q($id: ID!) {\\n  user(id: $id) { name }\\n}"}'
		);
	});

	it("returns an object with a string query as typed", () => {
		for (const envelope of [
			'{"query":"{ hero }"}',
			'{ "query": "{ hero }", "variables": {"a": 1} }',
			'{"operationName":"Q","variables":{},"query":"query Q { a }"}',
		]) {
			expect(graphqlWireBody(envelope), envelope).toBe(envelope);
		}
	});

	it("wraps JSON that is not an envelope", () => {
		expect(graphqlWireBody('{"variables":{}}')).toBe('{"query":"{\\"variables\\":{}}"}');
		expect(graphqlWireBody('{"query":5}')).toBe('{"query":"{\\"query\\":5}"}');
		expect(graphqlWireBody("[1]")).toBe('{"query":"[1]"}');
	});

	it("reads a repeated query member as the last one", () => {
		const lastIsString = '{"query":5,"query":"{ a }"}';
		expect(graphqlWireBody(lastIsString)).toBe(lastIsString);
		expect(graphqlWireBody('{"query":"{ a }","query":5}')).toBe(
			'{"query":"{\\"query\\":\\"{ a }\\",\\"query\\":5}"}'
		);
	});

	it("returns empty content as typed", () => {
		expect(graphqlWireBody("")).toBe("");
	});

	// Unparseable text that opens as an object with a quoted key is the author's
	// envelope, whatever a template inside it resolves to; anything else wraps.
	it("passes through unparseable text that opens as a quoted-key object", () => {
		for (const templated of [
			'{"query": {{q}} }',
			'{"query":"{ a }",}',
			'  \n{\t"query": "x" ',
			'{"a" 1}',
		]) {
			expect(graphqlWireBody(templated), templated).toBe(templated);
		}
	});

	// GraphQL reads the text without tokens: `{"query": {{q}}}` stays the
	// author's envelope rather than a query-less object that would be wrapped.
	it("keeps a templated query value an envelope", () => {
		expect(graphqlWireBody('{"query":{{q}}}')).toBe('{"query":{{q}}}');
	});

	it("wraps unparseable text that does not open as a quoted-key object", () => {
		expect(graphqlWireBody("{{query}}")).toBe('{"query":"{{query}}"}');
		expect(graphqlWireBody("{ me }")).toBe('{"query":"{ me }"}');
		expect(graphqlWireBody("{}x")).toBe('{"query":"{}x"}');
		expect(graphqlWireBody("{'a': 1}")).toBe('{"query":"{\'a\': 1}"}');
	});
});

describe("curlEscape", () => {
	it("keeps A-Za-z0-9-._~ and nothing else", () => {
		expect(curlEscape("aZ09-._~")).toBe("aZ09-._~");
		// `encodeURIComponent` leaves these five raw; curl escapes them.
		expect(curlEscape("!'()*")).toBe("%21%27%28%29%2A");
		expect(curlEscape(" &=?#/:+%@")).toBe("%20%26%3D%3F%23%2F%3A%2B%25%40");
	});

	it("writes a character as the uppercase hex of its UTF-8 bytes", () => {
		expect(curlEscape("\u00e9")).toBe("%C3%A9");
		expect(curlEscape("\u{1f600}")).toBe("%F0%9F%98%80");
		expect(curlEscape("\n\u007f")).toBe("%0A%7F");
		expect(curlEscape("")).toBe("");
	});
});

describe("graphqlGetQuery", () => {
	it("sends a bare document as the whole query parameter", () => {
		expect(graphqlGetQuery("{ hero { name } }")).toBe(
			"query=%7B%20hero%20%7B%20name%20%7D%20%7D"
		);
		expect(graphqlGetQuery("query Q($id: ID!) {\n me }")).toBe(
			"query=query%20Q%28%24id%3A%20ID%21%29%20%7B%0A%20me%20%7D"
		);
	});

	it("treats JSON that is not an envelope as a document", () => {
		expect(graphqlGetQuery('{"variables":{}}')).toBe("query=%7B%22variables%22%3A%7B%7D%7D");
		expect(graphqlGetQuery("[1]")).toBe("query=%5B1%5D");
		expect(graphqlGetQuery("{{query}}")).toBe("query=%7B%7Bquery%7D%7D");
	});

	it("has nothing to send for empty content", () => {
		expect(graphqlGetQuery("")).toBeUndefined();
	});

	it("writes an envelope's members in the author's order", () => {
		expect(
			graphqlGetQuery(
				'{"variables":{"a":1},"operationName":"Q","query":"{ a }","extensions":{"b":2}}'
			)
		).toBe(
			"variables=%7B%22a%22%3A1%7D&operationName=Q&query=%7B%20a%20%7D&extensions=%7B%22b%22%3A2%7D"
		);
	});

	// An integer-like key would be hoisted by a JS object; the author's order stands.
	it("writes variables as the engine's compact dump, in the author's order", () => {
		const query = '{"query":"{ a }","variables":{ "b" : 1.0, "1" : [ 1e3, "x" ], "a" : {} }}';
		expect(decodeURIComponent(graphqlGetQuery(query)!.split("&")[1])).toBe(
			'variables={"b":1.0,"1":[1000.0,"x"],"a":{}}'
		);
	});

	it("skips a null operationName, variables and extensions", () => {
		expect(
			graphqlGetQuery(
				'{"operationName":null,"query":"{ a }","variables":null,"extensions":null}'
			)
		).toBe("query=%7B%20a%20%7D");
	});

	it("keeps the body for an envelope the URL cannot carry", () => {
		for (const content of [
			'{"query":"{ a }","unknown":1}',
			'{"query":"{ a }","operationName":3}',
			'{"query":"{ a }","operationName":{}}',
			'{"query":"{ a }","variables":"{}"}',
			'{"query":"{ a }","variables":[]}',
			'{"query":"{ a }","extensions":1}',
			'{"query":"{ a }","variables":{{vars}}}',
			'{"query":"{ a }",}',
		]) {
			expect(graphqlGetQuery(content), content).toBeUndefined();
		}
	});

	it("reads a repeated member as the last value at the first position", () => {
		expect(graphqlGetQuery('{"query":"a","operationName":"X","query":"b"}')).toBe(
			"query=b&operationName=X"
		);
	});

	// The engine bounds the envelope at 128 levels and keeps the body past it.
	it("sends variables nested at the engine's bound and keeps the body one past it", () => {
		const nested = (objects: number) =>
			`{"query":"{ a }","variables":${'{"a":'.repeat(objects - 1)}{}${"}".repeat(objects - 1)}}`;
		expect(graphqlGetQuery(nested(127))).toMatch(/^query=%7B%20a%20%7D&variables=%7B/);
		expect(graphqlGetQuery(nested(128))).toBeUndefined();
	});
});

describe("urlWithQuery", () => {
	it.each([
		["a bare URL", "https://x/g", "https://x/g?q=1"],
		["an existing query", "https://x/g?a=1", "https://x/g?a=1&q=1"],
		["a trailing ?", "https://x/g?", "https://x/g?q=1"],
		["a trailing &", "https://x/g?a=1&", "https://x/g?a=1&q=1"],
		["a fragment", "https://x/g#top", "https://x/g?q=1#top"],
		["a query and a fragment", "https://x/g?a=1#top", "https://x/g?a=1&q=1#top"],
		["a ? only in the fragment", "https://x/g#a?b", "https://x/g?q=1#a?b"],
		["an empty URL", "", "?q=1"],
		["a # inside a token", "https://x/{{a#b}}", "https://x/{{a#b}}?q=1"],
		["a ? inside a token", "https://x/{{a?b}}", "https://x/{{a?b}}?q=1"],
		["a ? inside a token and a query", "https://x/{{a?b}}?a=1", "https://x/{{a?b}}?a=1&q=1"],
	])("joins onto %s", (_name, url, expected) => {
		expect(urlWithQuery(url, "q=1")).toBe(expected);
	});

	it("returns the URL unchanged for an empty query", () => {
		expect(urlWithQuery("https://x/g#top", "")).toBe("https://x/g#top");
	});
});

describe("wireBodyContent", () => {
	it("completes only the jsonrpc and graphql modes", () => {
		expect(wireBodyContent("jsonrpc", '{"method":"m"}')).toContain('"jsonrpc":"2.0"');
		expect(wireBodyContent("graphql", "{ me }")).toBe('{"query":"{ me }"}');
		for (const mode of ["json", "text", "xml", "raw", ""]) {
			expect(wireBodyContent(mode, '{"method":"m"}'), mode).toBe('{"method":"m"}');
		}
	});
});

describe("readCompactJson", () => {
	it("refuses a document that is not one", () => {
		for (const text of ["", " ", "[", '{"a"}', '{"a":1', "tru", "-", "1 2"]) {
			expect(readCompactJson(text), text).toBeUndefined();
		}
	});

	it("skips a leading byte-order mark and nothing else", () => {
		expect(readCompactJson('﻿{"a": 1}')?.text).toBe('{"a":1}');
		expect(readCompactJson('﻿﻿{"a":1}')).toBeUndefined();
	});

	it("survives a nesting deep enough to exhaust the stack", () => {
		expect(readCompactJson("[".repeat(200_000))).toBeUndefined();
	});
});
