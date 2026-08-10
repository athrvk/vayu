/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `graphql-body.ts` had no test file, and the body-destruction bug lived
 * exactly here: the pair round-tripped `{query, variables}` and silently
 * deleted everything else the envelope carried, so an imported multi-operation
 * request executed a different operation after any edit.
 *
 * The assertions therefore go through a full parse -> serialize cycle rather
 * than checking one function in isolation: that cycle is what a keystroke does,
 * and it is the only place the loss was observable.
 */

import { describe, expect, test } from "vitest";
import {
	classifyVariables,
	documentOutline,
	findOperationLine,
	operationNames,
	parseGraphQLBody,
	serializeGraphQLBody,
	toGraphQLEnvelope,
	type GraphQLBodyParts,
} from "./graphql-body";

/** What the panes do to a body: read it, change one thing, write it back. */
function edit(body: string, change: Partial<GraphQLBodyParts> = {}): string {
	return serializeGraphQLBody({ ...parseGraphQLBody(body), ...change });
}

describe("parseGraphQLBody", () => {
	test("splits the envelope into panes", () => {
		const parsed = parseGraphQLBody(
			JSON.stringify({ query: "{ me }", variables: { limit: 10 } })
		);
		expect(parsed.query).toBe("{ me }");
		expect(JSON.parse(parsed.variables)).toEqual({ limit: 10 });
		expect(parsed.operationName).toBe("");
		expect(parsed.extras).toEqual({});
	});

	test("reads operationName", () => {
		expect(
			parseGraphQLBody(JSON.stringify({ query: "query B { b }", operationName: "B" }))
				.operationName
		).toBe("B");
	});

	test("holds keys it does not model", () => {
		const parsed = parseGraphQLBody(
			JSON.stringify({ query: "{ me }", extensions: { trace: "on" } })
		);
		expect(parsed.extras).toEqual({ extensions: { trace: "on" } });
	});

	// The Insomnia import path: a bare document is not JSON, and showing it in
	// the query pane is better than showing an empty editor.
	test("falls back to the whole body as the query", () => {
		const parsed = parseGraphQLBody("query B { b }");
		expect(parsed.query).toBe("query B { b }");
		expect(parsed.variables).toBe("");
	});

	// A JSON body that is not an envelope (an array, a number, an object with no
	// `query`) is another user's payload arriving through a mode switch - it is
	// shown, not reinterpreted.
	test.each(["[1,2]", "42", '{"merchant":"mrc_8813"}'])(
		"keeps non-envelope %s intact",
		(body) => {
			expect(parseGraphQLBody(body).query).toBe(body);
		}
	);

	test("ignores a non-string operationName rather than sending it", () => {
		expect(
			parseGraphQLBody(JSON.stringify({ query: "{ me }", operationName: 7 })).operationName
		).toBe("");
	});
});

describe("serializeGraphQLBody", () => {
	test("omits variables that are mid-edit", () => {
		const written = edit(JSON.stringify({ query: "{ me }" }), { variables: "{ unclosed" });
		expect(JSON.parse(written)).toEqual({ query: "{ me }" });
	});

	test("omits an absent operationName rather than writing an empty one", () => {
		expect(JSON.parse(edit(JSON.stringify({ query: "{ me }" })))).toEqual({ query: "{ me }" });
	});
});

describe("a keystroke preserves the whole envelope", () => {
	// The bug itself. Editing the query of an imported multi-operation request
	// used to drop `operationName`, so the server picked an operation instead of
	// the user's. Mutation check: drop `operationName` from either half of
	// graphql-body.ts and this reddens.
	test("operationName survives an edit to the query", () => {
		const body = JSON.stringify({
			query: "query A { a } query B { b }",
			operationName: "B",
		});
		const written = edit(body, { query: "query A { a } query B { b2 }" });
		expect(JSON.parse(written)).toEqual({
			query: "query A { a } query B { b2 }",
			operationName: "B",
		});
	});

	test("operationName survives an edit to the variables", () => {
		const body = JSON.stringify({ query: "query B($n: Int) { b }", operationName: "B" });
		expect(JSON.parse(edit(body, { variables: '{"n": 2}' }))).toEqual({
			query: "query B($n: Int) { b }",
			operationName: "B",
			variables: { n: 2 },
		});
	});

	test("keys the editor does not model survive an edit", () => {
		const body = JSON.stringify({ query: "{ me }", extensions: { trace: "on" } });
		expect(JSON.parse(edit(body, { query: "{ you }" }))).toEqual({
			query: "{ you }",
			extensions: { trace: "on" },
		});
	});

	// Forward-compat has a limit worth stating: a modelled key always wins, so an
	// envelope cannot end up with two of them.
	test("a modelled key is written once", () => {
		const written = edit(JSON.stringify({ query: "{ me }" }), { query: "{ you }" });
		expect(written.match(/"query"/g)).toHaveLength(1);
	});
});

describe("operationNames", () => {
	test("lists named operations in source order", () => {
		expect(operationNames("query B { b } mutation A { a }")).toEqual(["B", "A"]);
	});

	// An anonymous operation has no name to put on the wire, and by spec it can
	// only be the sole operation - so there is nothing to pick between.
	test("is empty for an anonymous operation", () => {
		expect(operationNames("{ me }")).toEqual([]);
	});

	test("ignores fragments, which are not operations", () => {
		expect(operationNames("fragment F on User { id } query B { ...F }")).toEqual(["B"]);
	});

	// Typing is the normal case, and a half-written document must not throw.
	test.each(["", "   ", "query B {", "not graphql at all"])(
		"is empty for unparseable %j",
		(query) => {
			expect(operationNames(query)).toEqual([]);
		}
	);
});

describe("toGraphQLEnvelope", () => {
	test("wraps a bare document", () => {
		expect(JSON.parse(toGraphQLEnvelope("query B { b }"))).toEqual({ query: "query B { b }" });
	});

	test("leaves an envelope alone", () => {
		const body = JSON.stringify({ query: "{ me }", operationName: "B" });
		expect(JSON.parse(toGraphQLEnvelope(body))).toEqual({
			query: "{ me }",
			operationName: "B",
		});
	});

	// A JSON document that is not an envelope is still a query as far as the
	// mime type promised - wrapping it is what makes it reach the server.
	test("wraps JSON that is not an envelope", () => {
		expect(JSON.parse(toGraphQLEnvelope('{"notQuery": 1}'))).toEqual({
			query: '{"notQuery": 1}',
		});
	});

	test("produces an envelope for an empty body", () => {
		expect(JSON.parse(toGraphQLEnvelope(""))).toEqual({ query: "" });
	});
});

describe("variables that are not strict JSON", () => {
	/*
	 * The reported defect: `{"limit": {{n}}}` is the idiom the engine's template
	 * resolution exists for, and the serializer dropped it as "mid-edit invalid
	 * JSON" - the request went out with no variables and nothing said so.
	 */
	test("a templated variables object reaches the wire verbatim", () => {
		const body = serializeGraphQLBody({
			query: "query ($n: Int) { a(n: $n) }",
			variables: '{"limit": {{n}}}',
			operationName: "",
			extras: {},
		});
		expect(body).toBe('{"query":"query ($n: Int) { a(n: $n) }","variables":{"limit":{{n}}}}');
	});

	test("round-trips back into the pane through parse", () => {
		const parts = parseGraphQLBody('{"query":"q","variables":{"limit":{{n}},"tag":"{{t}}"}}');
		expect(parts.query).toBe("q");
		// Pretty-printed, so compare without the layout: the tokens are back in the
		// pane as the user typed them, not as placeholders.
		expect(parts.variables.replace(/\s+/g, "")).toBe('{"limit":{{n}},"tag":"{{t}}"}');
		// And back out again unchanged, so an edit elsewhere does not rewrite it.
		expect(serializeGraphQLBody(parts)).toBe(
			'{"query":"q","variables":{"limit":{{n}},"tag":"{{t}}"}}'
		);
	});

	test("genuinely broken text is still dropped, not written", () => {
		// PR #399's decision, and it stands: the query pane must keep saving while
		// the variables pane has an unclosed brace.
		expect(
			serializeGraphQLBody({
				query: "q",
				variables: '{"limit": ',
				operationName: "",
				extras: {},
			})
		).toBe('{"query":"q"}');
	});

	test("a body whose template sits outside `variables` is left as a raw query", () => {
		// The placeholder would survive into `extras` and be written back as a
		// placeholder. Refusing is what master already does with this body.
		const body = '{"query":"q","extensions":{"x":{{y}}}}';
		expect(parseGraphQLBody(body)).toEqual({
			query: body,
			variables: "",
			operationName: "",
			extras: {},
		});
	});
});

describe("classifyVariables", () => {
	test.each([
		["", "empty"],
		["   ", "empty"],
		['{"a":1}', "json"],
		['{"a":"{{token}}"}', "json"],
		['{"a": {{token}}}', "templated"],
		['{"a": ', "invalid"],
		["not json at all", "invalid"],
	])("%j is %s", (text, form) => {
		expect(classifyVariables(text)).toBe(form);
	});
});

describe("a string-typed `variables`", () => {
	/*
	 * The shape the Postman importer deliberately preserves. Pretty-printing it
	 * rendered `{"id":1}` as the escaped blob `"{\"id\":1}"` in the pane - correct
	 * JSON, unreadable, and un-editable without deleting the escapes by hand.
	 */
	test("shows verbatim in the pane rather than as an escaped blob", () => {
		const parts = parseGraphQLBody(JSON.stringify({ query: "q", variables: '{"id": 1}' }));
		expect(parts.variables).toBe('{"id": 1}');
	});

	test("becomes an object once the pane's text parses", () => {
		const parts = parseGraphQLBody(JSON.stringify({ query: "q", variables: '{"id": 1}' }));
		expect(JSON.parse(serializeGraphQLBody(parts))).toEqual({
			query: "q",
			variables: { id: 1 },
		});
	});

	test("an empty string variables value leaves the pane empty", () => {
		expect(parseGraphQLBody(JSON.stringify({ query: "q", variables: "" })).variables).toBe("");
	});
});

describe("documentOutline", () => {
	const TWO = ["", "query Users {", "  me { id }", "}", "", "mutation Add {", "  add", "}"].join(
		"\n"
	);

	test("carries the line each operation starts on", () => {
		expect(documentOutline(TWO)).toEqual([
			{ kind: "query", name: "Users", line: 2 },
			{ kind: "mutation", name: "Add", line: 6 },
		]);
	});

	test("keeps the anonymous shorthand, which has no name to match on", () => {
		expect(documentOutline("\n{ me { id } }")).toEqual([
			{ kind: "query", name: null, line: 2 },
		]);
	});

	test("says nothing about a document mid-edit", () => {
		expect(documentOutline("query Broken { me(")).toEqual([]);
	});
});

/*
 * The two ends of the outline's click-to-scroll hold *different copies* of the
 * document - the context bar reads the stored request, the editor holds the
 * live buffer - so the row is resolved by name here rather than carrying a line
 * across. These cases are that difference.
 */
describe("findOperationLine", () => {
	const BUFFER = ["mutation Add {", "  add", "}", "", "query Users {", "  me { id }", "}"].join(
		"\n"
	);

	test("finds the operation by name wherever the buffer has moved it", () => {
		// The stored copy had `Users` first; the buffer has it second.
		expect(findOperationLine(BUFFER, { name: "Users", index: 0 })).toBe(5);
	});

	test("does not find an operation the buffer has renamed away", () => {
		expect(findOperationLine(BUFFER, { name: "Members", index: 1 })).toBeNull();
	});

	test("falls back to the position for the anonymous operation", () => {
		expect(findOperationLine("\n\n{ me { id } }", { name: null, index: 0 })).toBe(3);
	});

	test("will not hand an anonymous row the named operation that took its place", () => {
		// Trusting the index alone would scroll to `Users` for a row that stood
		// for a shorthand document the buffer no longer has.
		expect(findOperationLine(BUFFER, { name: null, index: 0 })).toBeNull();
	});

	test("finds nothing in a document that does not parse", () => {
		expect(findOperationLine("query Users { me(", { name: "Users", index: 0 })).toBeNull();
	});
});
