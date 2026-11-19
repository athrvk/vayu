/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Both response funnels carry what the send's auth wrote (#1845, read since
 * #3634): `authHeaders` and `authQueryParam`, top-level on the live `/execute`
 * body and on `trace.request` in a stored run, written by one engine function
 * (`record_auth_provenance`). The session Console masks by them, so a funnel
 * that dropped one would store a credential in clear on that path.
 *
 * Mutation check: drop `...authProvenance(request)` from `sentSide` and the
 * stored case and the agreement case fail.
 */

import { describe, expect, it } from "vitest";
import type { SanityResult } from "@/types";
import { responseFromExecuteResult } from "./execute-mapping";
import { responseFromRunResult, type RunResultSample } from "./restore-response";

type Provenance = Pick<SanityResult, "authHeaders" | "authQueryParam">;

const executeResult = (provenance: Provenance): SanityResult =>
	({
		status: 200,
		statusText: "OK",
		headers: {},
		body: null,
		bodyRaw: "",
		bodySize: 0,
		timing: { totalMs: 5 },
		...provenance,
	}) as unknown as SanityResult;

const runResult = (provenance: Provenance): RunResultSample =>
	({
		timestamp: 1_700_000_000_000,
		statusCode: 200,
		statusText: "OK",
		latencyMs: 5,
		trace: {
			request: { method: "GET", url: "https://api.test/p", headers: {}, ...provenance },
			response: { status: 200, headers: {}, body: "" },
		},
	}) as unknown as RunResultSample;

const WROTE: Provenance = { authHeaders: ["X-Tenant-Key"], authQueryParam: "access_token" };

const provenanceOf = (state: { authHeaders?: string[]; authQueryParam?: string } | null) => ({
	authHeaders: state?.authHeaders,
	authQueryParam: state?.authQueryParam,
});

describe("auth provenance on both funnels", () => {
	it("the live funnel carries both names", () => {
		expect(provenanceOf(responseFromExecuteResult(executeResult(WROTE)))).toEqual(WROTE);
	});

	it("the stored funnel carries both names", () => {
		expect(provenanceOf(responseFromRunResult(runResult(WROTE)))).toEqual(WROTE);
	});

	it("both leave the keys absent when auth wrote none, an empty list or name included", () => {
		const none: Provenance = { authHeaders: [], authQueryParam: "" };
		for (const state of [
			responseFromExecuteResult(executeResult(none)),
			responseFromRunResult(runResult(none)),
		]) {
			expect(state).not.toHaveProperty("authHeaders");
			expect(state).not.toHaveProperty("authQueryParam");
		}
	});

	it("agree for the same send", () => {
		expect(provenanceOf(responseFromRunResult(runResult(WROTE)))).toEqual(
			provenanceOf(responseFromExecuteResult(executeResult(WROTE)))
		);
	});
});
