/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Both response funnels build one pane from one JSON body (issue #2459).
 *
 * The live `/execute` answer carries the received text as `bodyRaw` beside the
 * engine's parse of it; the stored trace carries only the text. The pane for a
 * send must read the same in the builder and when the run is opened from
 * History, and neither may be built from the parse, which sorts keys, keeps
 * only the last of a repeated one and rounds an integer past 2^53.
 * `binary-body-funnels.test.ts` is the shape: one input, both funnels, compare.
 */

import { describe, expect, it } from "vitest";

import { LARGE_BODY_BYTES } from "@/components/shared/response-viewer/utils";
import type { SanityResult } from "@/types";
import { responseFromExecuteResult } from "./execute-mapping";
import { responseFromRunResult, type RunResultSample } from "./restore-response";

const HEADERS = { "content-type": "application/json" };

const live = (bodyRaw: string, parsed: unknown): SanityResult =>
	({
		status: 200,
		statusText: "OK",
		headers: HEADERS,
		body: parsed,
		bodyRaw,
		bodyEncoding: "utf8",
		bodySize: bodyRaw.length,
		bodyCapped: false,
	}) as unknown as SanityResult;

const stored = (body: string): RunResultSample =>
	({
		timestamp: 1_700_000_000_000,
		statusCode: 200,
		statusText: "OK",
		latencyMs: 12,
		trace: {
			request: { method: "GET", url: "https://api.example.com/x", headers: {} },
			response: { headers: HEADERS, body },
		},
	}) as unknown as RunResultSample;

/** What the two funnels must agree on for one body. */
function paneFacts(r: ReturnType<typeof responseFromExecuteResult> | null) {
	return { body: r?.body, bodyRaw: r?.bodyRaw, size: r?.size };
}

const bigPad = "x".repeat(LARGE_BODY_BYTES + 16);

describe.each([
	["order, a duplicate and a big integer", '{"z":1,"a":{"id":9007199254740993},"2":0,"a":5}'],
	["an empty container and a scalar array", '{"o":{},"l":[],"n":[1,2.50,1e400]}'],
	["a body over the display gate", `{"pad":"${bigPad}"}`],
	["a JSON string", '"just a string"'],
	["text that is not JSON", "plain words, not {json}"],
])("a JSON response: %s", (_name, received) => {
	// The engine's parse differs from the text in exactly the ways above; no
	// funnel may read it, so a value that cannot match the text is enough.
	const parse = { engineParse: true };

	it("builds the same pane through both funnels", () => {
		expect(received.length).toBeGreaterThan(0);
		const fromLive = paneFacts(responseFromExecuteResult(live(received, parse)));
		const fromStore = paneFacts(responseFromRunResult(stored(received)));

		expect(fromLive.bodyRaw).toBe(received);
		expect(fromStore).toEqual(fromLive);
	});

	it("never builds the pane from the engine's parse", () => {
		const r = responseFromExecuteResult(live(received, parse));

		expect(r.body).not.toContain("engineParse");
		expect(r.bodyRaw).not.toContain("engineParse");
	});
});

describe("what the pane holds", () => {
	it("indents the received text with every digit and member intact", () => {
		const received = '{"z":1,"a":{"id":9007199254740993},"a":5}';
		const expected = [
			"{",
			'  "z": 1,',
			'  "a": {',
			'    "id": 9007199254740993',
			"  },",
			'  "a": 5',
			"}",
		].join("\n");

		expect(responseFromExecuteResult(live(received, {})).body).toBe(expected);
		expect(responseFromRunResult(stored(received))?.body).toBe(expected);
	});

	it("hands a body past the display gate back unindented, from both", () => {
		const received = `{"pad":"${bigPad}"}`;

		expect(received.length).toBeGreaterThan(LARGE_BODY_BYTES);
		expect(responseFromExecuteResult(live(received, {})).body).toBe(received);
		expect(responseFromRunResult(stored(received))?.body).toBe(received);
	});

	it("reports the same held size for a stored body as its received text", () => {
		const received = '{"a":1,"b":[2,3]}';

		// The pane copy is longer than the text; a size read off it would inflate.
		expect(responseFromRunResult(stored(received))?.size).toBe(received.length);
	});
});
