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
import { switchAutoHeader, autoHeaderToAdd, withoutAutoHeader, autoHeaderRow } from "./auto-header";
import { ACCEPT_HEADER, SSE_ACCEPT } from "@/constants/request";
import type { KeyValueItem } from "@/types";

const row = (id: string, key: string, value: string, enabled = true): KeyValueItem => ({
	id,
	key,
	value,
	enabled,
});

describe("switchAutoHeader on Accept", () => {
	it("adds the header when the setting turns on", () => {
		const result = switchAutoHeader(ACCEPT_HEADER, SSE_ACCEPT, [], "stream");

		expect(result.added).toBe(SSE_ACCEPT);
		expect(result.headers).toHaveLength(1);
		// The marker is what makes the add reversible; without it the header
		// outlives the setting, which is the whole bug this rule exists for.
		expect(result.headers[0]).toMatchObject({
			key: ACCEPT_HEADER,
			value: SSE_ACCEPT,
			enabled: true,
			source: "stream",
		});
	});

	it("takes the header back when the setting turns off", () => {
		const on = switchAutoHeader(ACCEPT_HEADER, SSE_ACCEPT, [], "stream");
		const off = switchAutoHeader(ACCEPT_HEADER, null, on.headers, "stream");

		expect(off.headers).toHaveLength(0);
		expect(off.added).toBeNull();
	});

	it("never overrides an Accept the user declared, even a different one", () => {
		const mine = [row("r1", "Accept", "application/json")];
		const result = switchAutoHeader(ACCEPT_HEADER, SSE_ACCEPT, mine, "stream");

		expect(result.added).toBeNull();
		expect(result.headers).toEqual(mine);
	});

	it("adds one anyway when the declared Accept is disabled - it is not sent", () => {
		const disabled = [row("r1", "Accept", "application/json", false)];
		const result = switchAutoHeader(ACCEPT_HEADER, SSE_ACCEPT, disabled, "stream");

		expect(result.added).toBe(SSE_ACCEPT);
		expect(result.headers).toHaveLength(2);
	});

	it("leaves a row alone once its marker has been cleared", () => {
		// KeyValueEditor clears `source` the moment a user retypes a marked row's
		// key or value; simulate that here rather than through the component,
		// since the boundary belongs to this rule, not to the editor.
		const on = switchAutoHeader(ACCEPT_HEADER, SSE_ACCEPT, [], "stream");
		const edited = on.headers.map((h) => {
			const { source: _source, ...rest } = h;
			return { ...rest, value: "application/json" };
		});

		const off = switchAutoHeader(ACCEPT_HEADER, null, edited, "stream");

		expect(off.headers).toEqual(edited);
	});

	it("recognises its own row with no earlier record at all", () => {
		// The bug this rule replaced (issue #1481): an in-memory ref recorded
		// which row a setting wrote, and could not survive a reload - a stale
		// auto-written row was then indistinguishable from the user's own.
		// `switchAutoHeader` takes no such record any more; a marked row is
		// recognised purely from the headers array itself.
		const afterReload = [autoHeaderRow(ACCEPT_HEADER, SSE_ACCEPT, "stream")];

		const off = switchAutoHeader(ACCEPT_HEADER, null, afterReload, "stream");

		expect(off.headers).toEqual([]);
	});

	it("does not touch a row a different setting marked", () => {
		const theirs = [autoHeaderRow(ACCEPT_HEADER, SSE_ACCEPT, "body-mode")];
		const off = switchAutoHeader(ACCEPT_HEADER, null, theirs, "stream");
		expect(off.headers).toEqual(theirs);
	});

	it("keeps the existing row when the required value has not changed", () => {
		const on = switchAutoHeader(ACCEPT_HEADER, SSE_ACCEPT, [], "stream");
		const again = switchAutoHeader(ACCEPT_HEADER, SSE_ACCEPT, on.headers, "stream");

		// Same array: re-adding would churn the Headers tab and move the row to
		// the end.
		expect(again.headers).toBe(on.headers);
		expect(again.added).toBeNull();
	});

	it("matches the header name case-insensitively", () => {
		const lower = [row("r1", "accept", "application/json")];
		expect(autoHeaderToAdd(ACCEPT_HEADER, SSE_ACCEPT, lower)).toBeNull();
	});

	it("removes nothing when no row carries the marker", () => {
		const headers = [row("r1", "Accept", SSE_ACCEPT)];
		expect(withoutAutoHeader(headers, ACCEPT_HEADER, "stream")).toEqual(headers);
	});
});
