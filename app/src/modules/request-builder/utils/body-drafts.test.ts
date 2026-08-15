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
import { switchBody, draftKey, emptyDrafts, type BodyDrafts } from "./body-drafts";

const JSON_BODY = '{"merchant":"mrc_8813","limit":50}';
const GQL_BODY = '{"query":"query { me { id } }"}';
const REQ_A = "req_a";
const REQ_B = "req_b";

/** `switchBody` for one request, which is every case but the last block. */
const inA = (
	from: Parameters<typeof switchBody>[0],
	to: Parameters<typeof switchBody>[1],
	body: string,
	drafts: BodyDrafts = emptyDrafts(REQ_A)
) => switchBody(from, to, body, REQ_A, drafts);

describe("which modes share a body", () => {
	it("puts json and text in one bucket, because they are one string", () => {
		expect(draftKey("json")).toBe("raw");
		expect(draftKey("text")).toBe("raw");
	});

	it("gives graphql its own, because it is an envelope", () => {
		expect(draftKey("graphql")).toBe("graphql");
	});

	// The decision recorded in the file's header: jsonrpc is one plain JSON
	// pane, not a structure this side parses - its envelope is completed
	// engine-side - so it reads and writes the same string json and text do.
	// Put it in its own bucket and switching JSON to JSON-RPC would blank an
	// editor showing the same document a moment earlier.
	it("puts jsonrpc in the raw bucket, because it is one plain document", () => {
		expect(draftKey("jsonrpc")).toBe("raw");
	});

	// Same reasoning again for xml: the pane holds one document this side never
	// parses (the engine sends it byte for byte), so it is the raw string every
	// other text mode edits, differing only in highlighting.
	it("puts xml in the raw bucket for the same reason", () => {
		expect(draftKey("xml")).toBe("raw");
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
		const out = inA("json", "graphql", JSON_BODY);
		expect(out.body).toBe("");
		expect(out.body).not.toContain("mrc_8813");
	});

	it("gives the JSON back when you return", () => {
		const toGql = inA("json", "graphql", JSON_BODY);
		const back = inA("graphql", "json", GQL_BODY, toGql.drafts);
		expect(back.body).toBe(JSON_BODY);
	});

	it("keeps the GraphQL envelope for when you return to it", () => {
		const toGql = inA("json", "graphql", JSON_BODY);
		const back = inA("graphql", "json", GQL_BODY, toGql.drafts);
		const again = inA("json", "graphql", JSON_BODY, back.drafts);
		expect(again.body).toBe(GQL_BODY);
	});
});

describe("json to text", () => {
	it("carries the text over, since only the highlighting differs", () => {
		// Clearing here would be the fix overshooting: it is the same string.
		expect(inA("json", "text", JSON_BODY).body).toBe(JSON_BODY);
	});

	it("carries it back too", () => {
		const toText = inA("json", "text", JSON_BODY);
		expect(inA("text", "json", JSON_BODY, toText.drafts).body).toBe(JSON_BODY);
	});
});

describe("json to jsonrpc", () => {
	const CALL = '{"method":"eth_blockNumber","params":[]}';

	// The shared bucket, from the user's side: the call you were editing as JSON
	// is still on screen after the switch, and switching back does not blank it.
	// Mutation check: give jsonrpc its own bucket in `draftKey` and both
	// assertions redden with an empty editor.
	it("carries the document over and back, since it is the same string", () => {
		expect(inA("json", "jsonrpc", CALL).body).toBe(CALL);

		const toRpc = inA("json", "jsonrpc", CALL);
		expect(inA("jsonrpc", "json", CALL, toRpc.drafts).body).toBe(CALL);
	});

	// And the bucket boundary that matters: GraphQL's envelope must not reach a
	// JSON-RPC pane, which is the original bug pointed at the new mode.
	it("does not hand the GraphQL envelope to the JSON-RPC editor", () => {
		const out = inA("graphql", "jsonrpc", GQL_BODY);
		expect(out.body).toBe("");
	});
});

describe("text to xml", () => {
	const SOAP = "<soap:Envelope><soap:Body><Ping/></soap:Body></soap:Envelope>";

	// The shared bucket from the user's side: a document pasted into the Text
	// pane before the mode was picked is still there after picking XML. Mutation
	// check: give xml a bucket of its own in `draftKey` and both assertions
	// redden with an empty editor.
	it("carries the document over and back", () => {
		expect(inA("text", "xml", SOAP).body).toBe(SOAP);

		const toXml = inA("text", "xml", SOAP);
		expect(inA("xml", "text", SOAP, toXml.drafts).body).toBe(SOAP);
	});

	it("does not hand the GraphQL envelope to the XML editor", () => {
		expect(inA("graphql", "xml", GQL_BODY).body).toBe("");
	});
});

describe("modes that have no body", () => {
	it("leaves the body alone on the way to none", () => {
		// Switching to None and back must not have destroyed anything either.
		expect(inA("json", "none", JSON_BODY).body).toBe(JSON_BODY);
	});

	it("still stashes what the outgoing mode held", () => {
		const toNone = inA("json", "none", JSON_BODY);
		expect(toNone.drafts.raw).toBe(JSON_BODY);
	});

	it("restores the raw draft when leaving none for json", () => {
		const drafts: BodyDrafts = { requestId: REQ_A, raw: JSON_BODY };
		expect(inA("none", "json", "", drafts).body).toBe(JSON_BODY);
	});

	it("does not stash anything for form-data, which keeps arrays", () => {
		const out = inA("form-data", "json", "", { requestId: REQ_A, raw: JSON_BODY });
		expect(out.body).toBe(JSON_BODY);
		expect(out.drafts).toEqual({ requestId: REQ_A, raw: JSON_BODY });
	});

	/*
	 * A bodyless mode is a *detour*, not a destination, and the detour is where
	 * `request.body` is at its most confusing: while you sit in None it still
	 * holds whatever the mode before it left there. Nothing sends or saves it -
	 * `execute-mapping.ts` builds form bodies from `formData` / `urlEncoded` and
	 * only reads `body` when the mode is not `none`, and a form-mode request
	 * reloads with `body: ""` because only json/text/graphql store `content` -
	 * but the draft has to survive the parking either way.
	 */
	it("gets the JSON back after parking behind GraphQL and None", () => {
		const toGql = inA("json", "graphql", JSON_BODY);
		const toNone = inA("graphql", "none", GQL_BODY, toGql.drafts);
		// The GraphQL envelope is what is sitting in `request.body` right now.
		expect(toNone.body).toBe(GQL_BODY);
		expect(inA("none", "json", toNone.body, toNone.drafts).body).toBe(JSON_BODY);
	});
});

describe("stashing the second time", () => {
	/*
	 * The stash must overwrite, not fill a hole. Skipping the write when the
	 * bucket is already occupied reads like an optimisation - the draft is
	 * "already saved" - and loses every edit after the first round trip. Nothing
	 * else in this file walks two round trips, so nothing else catches it.
	 */
	it("stashes the edit, not the text from the first visit", () => {
		const EDITED = '{"merchant":"mrc_9002"}';
		const first = inA("json", "graphql", JSON_BODY);
		const back = inA("graphql", "json", GQL_BODY, first.drafts);
		expect(back.body).toBe(JSON_BODY);

		// The user now edits the JSON and leaves again.
		const second = inA("json", "graphql", EDITED, back.drafts);
		expect(inA("graphql", "json", GQL_BODY, second.drafts).body).toBe(EDITED);
	});
});

describe("a mode with nothing stashed", () => {
	it("starts empty rather than inheriting the other bucket", () => {
		expect(inA("json", "graphql", JSON_BODY).body).toBe("");
	});
});

/*
 * `BodyPanel` is not remounted when you switch request tab: the provider resets
 * its state in an effect keyed on the request id. So a ref holding drafts
 * outlives the request that filled it, and without an owner the panel would
 * restore request A's payload into request B - the reported bug again, across
 * requests instead of across modes.
 */
describe("drafts belong to one request", () => {
	it("does not hand request A's body to request B", () => {
		const inRequestA = inA("json", "graphql", JSON_BODY);
		const inRequestB = switchBody("graphql", "json", "", REQ_B, inRequestA.drafts);
		expect(inRequestB.body).toBe("");
		expect(inRequestB.body).not.toContain("mrc_8813");
	});

	it("stamps the new request on what it stashes, rather than keeping the old owner", () => {
		// Otherwise the drafts would be dropped again on every single switch,
		// which is a quieter bug: GraphQL and JSON stop remembering each other.
		const inRequestA = inA("json", "graphql", JSON_BODY);
		const inRequestB = switchBody("graphql", "json", GQL_BODY, REQ_B, inRequestA.drafts);
		expect(inRequestB.drafts.requestId).toBe(REQ_B);
		expect(switchBody("json", "graphql", "", REQ_B, inRequestB.drafts).body).toBe(GQL_BODY);
	});

	it("keeps them while the request stays the same", () => {
		const toGql = inA("json", "graphql", JSON_BODY);
		expect(toGql.drafts.requestId).toBe(REQ_A);
		expect(inA("graphql", "json", GQL_BODY, toGql.drafts).body).toBe(JSON_BODY);
	});

	it("treats an unsaved request's null id as an owner like any other", () => {
		// A request that has never been saved has `id: null`. Two of them are not
		// the same request, but there is only ever one open at a time, so null
		// matching null is correct here - and null must not match a saved id.
		const unsaved = switchBody("json", "graphql", JSON_BODY, null, emptyDrafts(null));
		expect(switchBody("graphql", "json", "", null, unsaved.drafts).body).toBe(JSON_BODY);
		expect(switchBody("graphql", "json", "", REQ_A, unsaved.drafts).body).toBe("");
	});
});
