/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The reversible auto-header rule, on the setting that is not the body mode.
 *
 * `content-type.test.tsx` already covers this rule as the body mode drives it.
 * What is worth guarding separately is that the *extracted* rule is genuinely
 * general - it was pulled out of `content-type.ts` so the Event stream toggle
 * could reuse it rather than grow a second copy (issue #574), and a "general"
 * helper that quietly only works for `Content-Type` would be the copy with
 * extra steps.
 *
 * So every case here runs on `Accept`, and each one is a way the header could
 * outlive or overwrite something it should not.
 */

import { describe, it, expect } from "vitest";
import { switchAutoHeader, autoHeaderToAdd, withoutAutoHeader } from "./auto-header";
import { ACCEPT_HEADER, SSE_ACCEPT } from "@/constants/request";
import type { KeyValueItem } from "@/types";

const row = (id: string, key: string, value: string, enabled = true): KeyValueItem => ({
	id,
	key,
	value,
	enabled,
});

const REQ = "req_1";

describe("switchAutoHeader on Accept", () => {
	it("adds the header when the setting turns on", () => {
		const result = switchAutoHeader(ACCEPT_HEADER, SSE_ACCEPT, [], REQ, null);

		expect(result.added).toBe(SSE_ACCEPT);
		expect(result.headers).toHaveLength(1);
		expect(result.headers[0]).toMatchObject({
			key: ACCEPT_HEADER,
			value: SSE_ACCEPT,
			enabled: true,
		});
		// The record is what makes the add reversible; without it the header
		// outlives the setting, which is the whole bug this rule exists for.
		expect(result.auto).toMatchObject({ requestId: REQ, value: SSE_ACCEPT });
		expect(result.auto?.rowId).toBe(result.headers[0].id);
	});

	it("takes the header back when the setting turns off", () => {
		const on = switchAutoHeader(ACCEPT_HEADER, SSE_ACCEPT, [], REQ, null);
		const off = switchAutoHeader(ACCEPT_HEADER, null, on.headers, REQ, on.auto);

		expect(off.headers).toHaveLength(0);
		expect(off.auto).toBeNull();
		expect(off.added).toBeNull();
	});

	it("never overrides an Accept the user declared, even a different one", () => {
		const mine = [row("r1", "Accept", "application/json")];
		const result = switchAutoHeader(ACCEPT_HEADER, SSE_ACCEPT, mine, REQ, null);

		expect(result.added).toBeNull();
		expect(result.auto).toBeNull();
		expect(result.headers).toEqual(mine);
	});

	it("adds one anyway when the declared Accept is disabled - it is not sent", () => {
		const disabled = [row("r1", "Accept", "application/json", false)];
		const result = switchAutoHeader(ACCEPT_HEADER, SSE_ACCEPT, disabled, REQ, null);

		expect(result.added).toBe(SSE_ACCEPT);
		expect(result.headers).toHaveLength(2);
	});

	it("leaves a row the user has since retyped alone", () => {
		const on = switchAutoHeader(ACCEPT_HEADER, SSE_ACCEPT, [], REQ, null);
		// Same row id, different value: theirs now.
		const edited = on.headers.map((h) => ({ ...h, value: "application/json" }));

		const off = switchAutoHeader(ACCEPT_HEADER, null, edited, REQ, on.auto);

		expect(off.headers).toEqual(edited);
	});

	it("drops a record belonging to another request rather than applying it", () => {
		// Row ids are not unique across a duplicated request, so a stale record
		// could otherwise delete a header the current request owns.
		const theirs = switchAutoHeader(ACCEPT_HEADER, SSE_ACCEPT, [], "req_other", null);
		const off = switchAutoHeader(ACCEPT_HEADER, null, theirs.headers, REQ, theirs.auto);

		expect(off.headers).toEqual(theirs.headers);
		expect(off.auto).toBeNull();
	});

	it("keeps the existing row when the required value has not changed", () => {
		const on = switchAutoHeader(ACCEPT_HEADER, SSE_ACCEPT, [], REQ, null);
		const again = switchAutoHeader(ACCEPT_HEADER, SSE_ACCEPT, on.headers, REQ, on.auto);

		// Same array and same record: re-adding would churn the Headers tab and
		// move the row to the end.
		expect(again.headers).toBe(on.headers);
		expect(again.auto).toBe(on.auto);
		expect(again.added).toBeNull();
	});

	it("matches the header name case-insensitively", () => {
		const lower = [row("r1", "accept", "application/json")];
		expect(autoHeaderToAdd(ACCEPT_HEADER, SSE_ACCEPT, lower)).toBeNull();
	});

	it("removes nothing when the record names a row that is gone", () => {
		const headers = [row("r1", "Accept", SSE_ACCEPT)];
		const stale = { requestId: REQ, rowId: "r-gone", value: SSE_ACCEPT };
		expect(withoutAutoHeader(headers, ACCEPT_HEADER, stale)).toEqual(headers);
	});
});
