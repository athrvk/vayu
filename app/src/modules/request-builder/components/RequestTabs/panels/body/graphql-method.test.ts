/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The method side effect of the GraphQL body mode (issue #1228).
 *
 * Driven at the module level rather than through `BodyPanel`'s mode picker,
 * for the reason `content-type.test.tsx` records: jsdom never fires the
 * pointer events a Radix `Select` commits a value on, so a test that looked
 * like it exercised the handler would exercise nothing.
 */

import { describe, expect, it } from "vitest";
import { sendsGraphQLInTheUrl, switchGraphQLMethod } from "./graphql-method";

describe("switchGraphQLMethod", () => {
	// The reported defect: a new request is a GET, and picking GraphQL used to
	// leave it one - so the envelope went out as a body on a GET and the server
	// answered a bare 400.
	it("moves the default GET to POST when GraphQL is chosen", () => {
		const result = switchGraphQLMethod("graphql", "GET", undefined);

		expect(result.method).toBe("POST");
		expect(result.methodSource).toBe("graphql");
	});

	// The other half of the rule, and the half a side effect usually forgets:
	// the mode that took the method away puts it back.
	it("puts the method back when GraphQL is left", () => {
		const result = switchGraphQLMethod("json", "POST", "graphql");

		expect(result.method).toBe("GET");
		expect(result.methodSource).toBeUndefined();
	});

	// A method someone picked is a choice, and completing a choice is not the
	// same as overriding one. PUT on a GraphQL endpoint is unusual, which is
	// exactly why it must survive.
	it("never overrides a method the user chose", () => {
		const result = switchGraphQLMethod("graphql", "PUT", undefined);

		expect(result.method).toBe("PUT");
		expect(result.methodSource).toBeUndefined();
	});

	// The same rule read in the other direction: the marker says GraphQL wrote
	// POST, the user has since picked DELETE, so there is nothing of ours left
	// to revert and handing back GET would be its own silent rewrite. In the
	// app this case cannot arise from a hand-picked method any more - the
	// selector clears the marker itself - but a marker written by something
	// else (MCP, import) must be held to the same rule.
	it("does not revert a method the marker no longer matches", () => {
		const result = switchGraphQLMethod("none", "DELETE", "graphql");

		expect(result.method).toBe("DELETE");
		expect(result.methodSource).toBeUndefined();
	});

	// Recognises its own marker with no earlier record at all - the fix for
	// issue #1505: nothing outside the request's own state has to say the
	// method is still GraphQL's, so a value rebuilt fresh from storage after a
	// reload works exactly like one held in memory the whole time.
	it("puts the method back after a reload, from the marker alone", () => {
		const result = switchGraphQLMethod("json", "POST", "graphql");

		expect(result.method).toBe("GET");
		expect(result.methodSource).toBeUndefined();
	});

	// Re-selecting GraphQL keeps the marker rather than re-deriving it, so a
	// second visit to the mode you are already in cannot overwrite the method
	// you have chosen inside it.
	it("keeps its marker when GraphQL is re-selected", () => {
		const result = switchGraphQLMethod("graphql", "PUT", "graphql");

		expect(result.method).toBe("PUT");
		expect(result.methodSource).toBe("graphql");
	});

	// Nothing to put back: a mode change between two non-GraphQL modes owns no
	// method at all.
	it("leaves the method alone with no marker to act on", () => {
		const result = switchGraphQLMethod("json", "GET", undefined);

		expect(result.method).toBe("GET");
		expect(result.methodSource).toBeUndefined();
	});
});

describe("sendsGraphQLInTheUrl", () => {
	// What the Query header's notice is keyed on: GET is the transport that
	// puts the document in the URL, every other method carries the envelope.
	it("is true for GET alone", () => {
		expect(sendsGraphQLInTheUrl("GET")).toBe(true);
		expect(sendsGraphQLInTheUrl("POST")).toBe(false);
		expect(sendsGraphQLInTheUrl("PUT")).toBe(false);
	});
});
