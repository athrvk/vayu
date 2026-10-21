/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which context a body binds under, restated from the engine (issue #2639).
 *
 * `bodyFieldContext` is the renderer's copy of `body_context`
 * (`engine/src/core/scenario_data.cpp`), and `graphqlBodyIsEnveloped` of
 * `graphql_body_is_enveloped` (`engine/src/http/graphql_body.cpp`). The tables
 * are the engine's: one row per arm of `body_context`'s switch, and the
 * envelope cases `graphql_body_test.cpp` asserts through `graphql_wire_body`
 * (a body it passes through is enveloped, one it wraps is not).
 *
 * The mode table is a `Record<BodyMode, …>`, so a body mode added to the app
 * fails type-check here until someone decides which context it binds under.
 */

import { describe, it, expect } from "vitest";
import type { BodyMode } from "@/types";
import {
	bodyFieldContext,
	graphqlBodyIsEnveloped,
	type DataFieldContext,
} from "./data-bind-escaping";

const ENVELOPE = '{"query":"{ me }"}';
const BARE_DOCUMENT = "{ me { id } }";

const CONTEXT_BY_MODE: Record<Exclude<BodyMode, "graphql">, DataFieldContext> = {
	json: "json",
	jsonrpc: "json",
	xml: "xml",
	text: "plain",
	none: "plain",
	"form-data": "plain",
	"x-www-form-urlencoded": "plain",
	binary: "plain",
};

describe("bodyFieldContext", () => {
	it.each(Object.entries(CONTEXT_BY_MODE))("binds a %s body as %s", (mode, context) => {
		// The content is irrelevant outside graphql; an envelope is the text most
		// likely to tempt a wrong answer.
		expect(bodyFieldContext(mode as BodyMode, ENVELOPE)).toBe(context);
	});

	it("binds a graphql envelope as JSON", () => {
		expect(bodyFieldContext("graphql", ENVELOPE)).toBe("json");
	});

	it("binds a bare graphql document as plain, since the engine escapes it when it wraps it", () => {
		expect(bodyFieldContext("graphql", BARE_DOCUMENT)).toBe("plain");
	});
});

describe("graphqlBodyIsEnveloped", () => {
	it.each([
		["the envelope", ENVELOPE],
		[
			"an envelope with its own whitespace and key order",
			'  { "variables": {}, "query": "{ me }" }  ',
		],
		[
			"an envelope whose unresolved token makes it unreadable",
			'{"query":"q","variables":{"limit":{{n}}}}',
		],
	])("passes %s through", (_name, body) => {
		expect(graphqlBodyIsEnveloped(body)).toBe(true);
	});

	it.each([
		["a bare query", "{ me }"],
		["a bare mutation", "mutation M { m }"],
		["a selection set that starts with a brace", BARE_DOCUMENT],
		["an object with no query", '{"notQuery":1}'],
		["an object whose query is not a string", '{"query":42}'],
		["a JSON array", "[1,2]"],
		["a JSON number", "42"],
		["an empty body", ""],
	])("wraps %s", (_name, body) => {
		expect(graphqlBodyIsEnveloped(body)).toBe(false);
	});
});
