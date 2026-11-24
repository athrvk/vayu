/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Recording an `assert.snapshot` baseline from the reply on screen (#3807).
 * That the method table matches the catalogue is
 * `element-kinds.conformance.test.tsx`'s job.
 */

import { describe, it, expect } from "vitest";
import {
	DEFAULT_SNAPSHOT_METHOD,
	baselineFromReply,
	snapshotMethodOf,
} from "./list-snapshot-baseline";

const TOOLS = [{ name: "search", inputSchema: { type: "object" } }, { name: "fetch" }];
const PROMPTS = [{ name: "summarise", arguments: [{ name: "text", required: true }] }];
const REPLY = { jsonrpc: "2.0", id: 1, result: { tools: TOOLS, prompts: PROMPTS } };

describe("baselineFromReply", () => {
	it("reads the list the method names, as the reply carried it", () => {
		expect(baselineFromReply(JSON.stringify(REPLY), "tools/list")).toEqual(TOOLS);
	});

	// Mutation check: read `tools` whatever the method is and the second
	// expectation answers the tools list, the first the prompts' own.
	it("reads the list of its own method, not the first one the result has", () => {
		expect(baselineFromReply(JSON.stringify(REPLY), "prompts/list")).toEqual(PROMPTS);
		expect(baselineFromReply(JSON.stringify(REPLY), "resources/list")).toBeNull();
	});

	it("finds a list under the wrong method as no list", () => {
		const toolsOnly = JSON.stringify({ result: { tools: TOOLS } });

		expect(baselineFromReply(toolsOnly, "prompts/list")).toBeNull();
	});

	it("records an empty list: a server that answers none has an empty baseline", () => {
		expect(baselineFromReply(JSON.stringify({ result: { tools: [] } }), "tools/list")).toEqual(
			[]
		);
	});

	it.each([
		["a body that is not JSON", "<html>502</html>"],
		["an empty body", ""],
		["an error response", JSON.stringify({ error: { code: -32601, message: "no" } })],
		["a result with no list", JSON.stringify({ result: {} })],
		["a list that is not an array", JSON.stringify({ result: { tools: { a: 1 } } })],
		["a null result", JSON.stringify({ result: null })],
		["a JSON array", JSON.stringify([REPLY])],
		["a JSON scalar", "7"],
	])("has no list in %s", (_name, body) => {
		expect(baselineFromReply(body, "tools/list")).toBeNull();
	});

	it("has no list for a method the snapshot does not cover, whatever the result holds", () => {
		const body = JSON.stringify({ result: { constructor: [1], tools: TOOLS } });

		expect(baselineFromReply(body, "constructor")).toBeNull();
		expect(baselineFromReply(body, "tools/call")).toBeNull();
	});

	describe("an event stream", () => {
		const notification = JSON.stringify({
			jsonrpc: "2.0",
			method: "notifications/progress",
			params: { progress: 1 },
		});

		it("reads the last JSON-RPC response, past the notifications around it", () => {
			const body = [
				`event: message\ndata: ${notification}`,
				`event: message\ndata: ${JSON.stringify(REPLY)}`,
				`event: message\ndata: ${notification}`,
			].join("\n\n");

			expect(baselineFromReply(body, "tools/list")).toEqual(TOOLS);
		});

		it("reads CRLF framing and a data line with no space after the colon", () => {
			const body = `event: message\r\ndata:${JSON.stringify(REPLY)}\r\n\r\n`;

			expect(baselineFromReply(body, "tools/list")).toEqual(TOOLS);
		});

		it("has no list when the stream ends without a response", () => {
			expect(baselineFromReply(`data: ${notification}\n\n`, "tools/list")).toBeNull();
		});

		// Mutation check: drop the distinct-id refusal in `finalReply` and the
		// stream below answers the last response's list instead of none.
		it("refuses a stream whose responses carry more than one id", () => {
			const other = { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "other" }] } };
			const body = [
				`event: message\ndata: ${JSON.stringify(REPLY)}`,
				`event: message\ndata: ${JSON.stringify(other)}`,
			].join("\n\n");

			expect(baselineFromReply(body, "tools/list")).toBeNull();
		});

		it("reads a stream that repeats one id, the last such response winning", () => {
			const later = { ...REPLY, result: { tools: [{ name: "later" }] } };
			const body = [JSON.stringify(REPLY), JSON.stringify(later)]
				.map((reply) => `event: message\ndata: ${reply}`)
				.join("\n\n");

			expect(baselineFromReply(body, "tools/list")).toEqual([{ name: "later" }]);
		});

		// Mutation check: read every event whatever it is named and the error
		// frame's id 2 makes this stream ambiguous, so the list vanishes.
		it("ignores an event that is not a message", () => {
			const failure = { jsonrpc: "2.0", id: 2, error: { code: -1, message: "x" } };
			const body = [
				`event: message\ndata: ${JSON.stringify(REPLY)}`,
				`event: error\ndata: ${JSON.stringify(failure)}`,
			].join("\n\n");

			expect(baselineFromReply(body, "tools/list")).toEqual(TOOLS);
		});

		it("reads an event with no event line as a message", () => {
			expect(baselineFromReply(`data: ${JSON.stringify(REPLY)}\n\n`, "tools/list")).toEqual(
				TOOLS
			);
		});
	});
});

describe("snapshotMethodOf", () => {
	it("is the element's own method", () => {
		expect(snapshotMethodOf({ method: "resources/list" })).toBe("resources/list");
	});

	it("is the default while the element names none", () => {
		expect(snapshotMethodOf({})).toBe(DEFAULT_SNAPSHOT_METHOD);
		expect(snapshotMethodOf({ method: 7 })).toBe(DEFAULT_SNAPSHOT_METHOD);
	});
});
