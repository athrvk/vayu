/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Switching body mode destroyed the body, and had for a long time.
 *
 * All of JSON, text and GraphQL share `request.body` - the stored shape is one
 * discriminated union, `{"mode":"json","content":"..."}` - so switching mode
 * handed the same string to a different reader. From JSON to GraphQL that
 * meant `parseGraphQLBody` found no `query` key, fell back to treating the
 * payload as a raw query string, and one keystroke later the body was:
 *
 *     {"query":"{\"merchant\":\"mrc_8813\",\"limit\":50}"}
 *
 * Switching back showed *that* in the JSON editor. The payload was gone, with
 * no undo.
 *
 * The fix is buckets, not per-mode isolation: `json` and `text` are the same
 * raw string with different highlighting, so text carries between them
 * deliberately. `graphql` is an envelope and keeps its own.
 */

import { describe, it, expect } from "vitest";
import { switchBody, draftKey, type BodyDrafts } from "./body-drafts";

const JSON_BODY = '{"merchant":"mrc_8813","limit":50}';
const GQL_BODY = '{"query":"query { me { id } }"}';

describe("which modes share a body", () => {
	it("puts json and text in one bucket, because they are one string", () => {
		expect(draftKey("json")).toBe("raw");
		expect(draftKey("text")).toBe("raw");
	});

	it("gives graphql its own, because it is an envelope", () => {
		expect(draftKey("graphql")).toBe("graphql");
	});

	it.each(["none", "form-data", "x-www-form-urlencoded"] as const)(
		"gives %s none, since it does not use request.body",
		(mode) => {
			expect(draftKey(mode)).toBeNull();
		}
	);
});

describe("json to graphql and back", () => {
	it("does not hand the JSON payload to the GraphQL editor", () => {
		// The bug, stated directly.
		const out = switchBody("json", "graphql", JSON_BODY, {});
		expect(out.body).toBe("");
		expect(out.body).not.toContain("mrc_8813");
	});

	it("gives the JSON back when you return", () => {
		const toGql = switchBody("json", "graphql", JSON_BODY, {});
		const back = switchBody("graphql", "json", GQL_BODY, toGql.drafts);
		expect(back.body).toBe(JSON_BODY);
	});

	it("keeps the GraphQL envelope for when you return to it", () => {
		const toGql = switchBody("json", "graphql", JSON_BODY, {});
		const back = switchBody("graphql", "json", GQL_BODY, toGql.drafts);
		const again = switchBody("json", "graphql", JSON_BODY, back.drafts);
		expect(again.body).toBe(GQL_BODY);
	});
});

describe("json to text", () => {
	it("carries the text over, since only the highlighting differs", () => {
		// Clearing here would be the fix overshooting: it is the same string.
		expect(switchBody("json", "text", JSON_BODY, {}).body).toBe(JSON_BODY);
	});

	it("carries it back too", () => {
		const toText = switchBody("json", "text", JSON_BODY, {});
		expect(switchBody("text", "json", JSON_BODY, toText.drafts).body).toBe(JSON_BODY);
	});
});

describe("modes that have no body", () => {
	it("leaves the body alone on the way to none", () => {
		// Switching to None and back must not have destroyed anything either.
		expect(switchBody("json", "none", JSON_BODY, {}).body).toBe(JSON_BODY);
	});

	it("still stashes what the outgoing mode held", () => {
		const toNone = switchBody("json", "none", JSON_BODY, {});
		expect(toNone.drafts.raw).toBe(JSON_BODY);
	});

	it("restores the raw draft when leaving none for json", () => {
		const drafts: BodyDrafts = { raw: JSON_BODY };
		expect(switchBody("none", "json", "", drafts).body).toBe(JSON_BODY);
	});

	it("does not stash anything for form-data, which keeps arrays", () => {
		const out = switchBody("form-data", "json", "", { raw: JSON_BODY });
		expect(out.body).toBe(JSON_BODY);
		expect(out.drafts).toEqual({ raw: JSON_BODY });
	});
});

describe("a mode with nothing stashed", () => {
	it("starts empty rather than inheriting the other bucket", () => {
		expect(switchBody("json", "graphql", JSON_BODY, {}).body).toBe("");
	});
});
