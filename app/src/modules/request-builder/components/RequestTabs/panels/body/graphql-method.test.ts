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
import type { AutoMethod } from "../../../../types";
import { sendsGraphQLInTheUrl, switchGraphQLMethod } from "./graphql-method";

const REQUEST = "req_1";

describe("switchGraphQLMethod", () => {
	// The reported defect: a new request is a GET, and picking GraphQL used to
	// leave it one - so the envelope went out as a body on a GET and the server
	// answered a bare 400.
	it("moves the default GET to POST when GraphQL is chosen", () => {
		const result = switchGraphQLMethod("graphql", "GET", REQUEST, null);

		expect(result.method).toBe("POST");
		expect(result.auto).toEqual({ requestId: REQUEST, method: "POST", previous: "GET" });
	});

	// The other half of the rule, and the half a side effect usually forgets:
	// the mode that took the method away puts it back.
	it("puts the method back when GraphQL is left", () => {
		const auto: AutoMethod = { requestId: REQUEST, method: "POST", previous: "GET" };

		const result = switchGraphQLMethod("json", "POST", REQUEST, auto);

		expect(result.method).toBe("GET");
		expect(result.auto).toBeNull();
	});

	// A method someone picked is a choice, and completing a choice is not the
	// same as overriding one. PUT on a GraphQL endpoint is unusual, which is
	// exactly why it must survive.
	it("never overrides a method the user chose", () => {
		const result = switchGraphQLMethod("graphql", "PUT", REQUEST, null);

		expect(result.method).toBe("PUT");
		expect(result.auto).toBeNull();
	});

	// The same rule read in the other direction: this side effect wrote POST,
	// the user has since picked DELETE, so there is nothing of ours left to
	// revert and handing back GET would be its own silent rewrite.
	it("does not revert a method the user changed after the switch", () => {
		const auto: AutoMethod = { requestId: REQUEST, method: "POST", previous: "GET" };

		const result = switchGraphQLMethod("none", "DELETE", REQUEST, auto);

		expect(result.method).toBe("DELETE");
		expect(result.auto).toBeNull();
	});

	// The provider's ref outlives the request that filled it, so a record from
	// another request must not be applied to this one - the reason
	// `switchAutoHeader` carries a `requestId` too.
	it("drops a record belonging to another request", () => {
		const auto: AutoMethod = { requestId: "req_other", method: "POST", previous: "GET" };

		const entering = switchGraphQLMethod("graphql", "GET", REQUEST, auto);
		expect(entering.auto).toEqual({ requestId: REQUEST, method: "POST", previous: "GET" });

		const leaving = switchGraphQLMethod("json", "POST", REQUEST, auto);
		expect(leaving.method).toBe("POST");
		expect(leaving.auto).toBeNull();
	});

	// Re-selecting GraphQL keeps the record rather than re-deriving one, so a
	// second visit to the mode you are already in cannot overwrite the method
	// you have chosen inside it.
	it("keeps its record when GraphQL is re-selected", () => {
		const auto: AutoMethod = { requestId: REQUEST, method: "POST", previous: "GET" };

		const result = switchGraphQLMethod("graphql", "PUT", REQUEST, auto);

		expect(result.method).toBe("PUT");
		expect(result.auto).toBe(auto);
	});

	// Nothing to put back: a mode change between two non-GraphQL modes owns no
	// method at all.
	it("leaves the method alone with no record to act on", () => {
		const result = switchGraphQLMethod("json", "GET", REQUEST, null);

		expect(result.method).toBe("GET");
		expect(result.auto).toBeNull();
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
