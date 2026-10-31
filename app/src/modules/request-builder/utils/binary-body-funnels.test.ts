/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Both response funnels read a base64 body the same way (issue #2458).
 *
 * The live `/execute` answer always names `bodyEncoding`; the stored trace
 * writes `bodyEncoding: "base64"` only when it applies and keeps the same
 * base64 in `body`. Before this the restored pane showed U+FFFD where the live
 * one showed an empty 500, and neither read a declared charset.
 * `body-capped-funnels.test.ts` is the shape: one input, both funnels, compare.
 */

import { describe, expect, it } from "vitest";

import type { SanityResult } from "@/types";
import { responseFromExecuteResult } from "./execute-mapping";
import { responseFromRunResult, type RunResultSample } from "./restore-response";

const LATIN1 = [0x63, 0x61, 0x66, 0xe9]; // "café" in ISO-8859-1
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff];
const base64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

const live = (headers: Record<string, string>, bytes: number[]): SanityResult =>
	({
		status: 200,
		statusText: "OK",
		headers,
		body: null,
		bodyRaw: base64(bytes),
		bodyEncoding: "base64",
		bodySize: bytes.length,
		bodyCapped: false,
	}) as unknown as SanityResult;

const stored = (headers: Record<string, string>, bytes: number[]): RunResultSample =>
	({
		timestamp: 1_700_000_000_000,
		statusCode: 200,
		statusText: "OK",
		latencyMs: 12,
		trace: {
			request: { method: "GET", url: "https://api.example.com/x", headers: {} },
			response: { headers, body: base64(bytes), bodyEncoding: "base64" },
		},
	}) as unknown as RunResultSample;

/** The fields the two funnels must agree on for one body. */
function bodyFacts(r: ReturnType<typeof responseFromExecuteResult> | null) {
	return {
		body: r?.body,
		bodyRaw: r?.bodyRaw,
		size: r?.size,
		bytes: r?.rawBytes && Array.from(r.rawBytes.data),
		isText: r?.rawBytes?.isText,
		notice: r?.rawBytes?.notice,
	};
}

describe.each([
	["Latin-1 text", { "content-type": "text/html; charset=iso-8859-1" }, LATIN1],
	["a PNG", { "content-type": "image/png" }, PNG],
])("a base64 body: %s", (_name, headers, bytes) => {
	it("builds the same body state through both funnels", () => {
		expect(bytes.length).toBeGreaterThan(0);
		const fromLive = bodyFacts(responseFromExecuteResult(live(headers, bytes)));
		const fromStore = bodyFacts(responseFromRunResult(stored(headers, bytes)));

		expect(fromLive.bytes).toEqual(bytes);
		expect(fromStore).toEqual(fromLive);
	});

	it("never leaves the base64 where text is read", () => {
		for (const r of [
			responseFromExecuteResult(live(headers, bytes)),
			responseFromRunResult(stored(headers, bytes)),
		]) {
			expect(r?.body).not.toBe(base64(bytes));
			expect(r?.bodyRaw).not.toBe(base64(bytes));
			expect(r?.size).toBe(bytes.length);
		}
	});
});

describe("what each body becomes", () => {
	it("decodes declared Latin-1 to its text", () => {
		const r = responseFromExecuteResult(
			live({ "content-type": "text/html; charset=iso-8859-1" }, LATIN1)
		);
		expect(r.body).toBe("café");
		expect(r.rawBytes?.isText).toBe(true);
	});

	it("gives an image no text", () => {
		const r = responseFromRunResult(stored({ "content-type": "image/png" }, PNG));
		expect(r?.body).toBe("");
		expect(r?.rawBytes?.isText).toBe(false);
	});

	it("counts a truncated stored body by its bytes, and the original by bodyBytes", () => {
		const sample = stored({ "content-type": "image/png" }, PNG.slice(0, 9));
		const response = sample.trace!.response as Record<string, unknown>;
		response.bodyTruncated = true;
		response.bodyBytes = 4096;

		const r = responseFromRunResult(sample);
		expect(r?.rawBytes?.data.length).toBe(9);
		expect(r?.size).toBe(4096);
	});
});

describe("a utf8 body", () => {
	it("carries no bytes through either funnel, including a row stored before the key", () => {
		const headers = { "content-type": "text/plain" };
		const fromLive = responseFromExecuteResult({
			...live(headers, []),
			bodyRaw: "plain",
			bodyEncoding: "utf8",
			bodySize: 5,
		});
		const oldRow = stored(headers, []);
		oldRow.trace!.response = { headers, body: "plain" };
		const fromStore = responseFromRunResult(oldRow);

		expect(bodyFacts(fromStore)).toEqual(bodyFacts(fromLive));
		expect(fromLive.body).toBe("plain");
		expect("rawBytes" in fromLive).toBe(false);
		expect(fromStore && "rawBytes" in fromStore).toBe(false);
	});
});
