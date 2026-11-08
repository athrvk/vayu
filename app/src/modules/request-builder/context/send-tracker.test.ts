/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi } from "vitest";
import { createSendTracker, type InFlightSends } from "./send-tracker";

function tracked() {
	const seen: InFlightSends[] = [];
	const onChange = vi.fn((sends: InFlightSends) => seen.push(sends));
	return { tracker: createSendTracker(onChange), onChange, latest: () => seen[seen.length - 1] };
}

describe("createSendTracker", () => {
	it("marks a request in flight from begin until its finish", () => {
		const { tracker, latest } = tracked();
		const send = tracker.begin("A");
		expect(latest()?.has("A")).toBe(true);
		expect(send.isCurrent()).toBe(true);

		send.finish();
		expect(latest()?.has("A")).toBe(false);
	});

	it("keeps a newer send in flight when the overtaken one finishes", () => {
		const { tracker, latest, onChange } = tracked();
		const first = tracker.begin("A");
		const second = tracker.begin("A");
		expect(first.isCurrent()).toBe(false);
		expect(second.isCurrent()).toBe(true);

		const changes = onChange.mock.calls.length;
		first.finish();
		// A stale finish is not a change at all, so nothing re-renders for it.
		expect(onChange.mock.calls.length).toBe(changes);
		expect(latest()?.has("A")).toBe(true);

		second.finish();
		expect(latest()?.has("A")).toBe(false);
	});

	it("tracks each request on its own", () => {
		const { tracker, latest } = tracked();
		const a = tracker.begin("A");
		const b = tracker.begin("B");
		a.finish();
		expect(latest()?.has("A")).toBe(false);
		expect(latest()?.has("B")).toBe(true);
		expect(b.isCurrent()).toBe(true);
	});

	it("hands out a new map on every change, never the previous one mutated", () => {
		const { tracker, onChange } = tracked();
		const send = tracker.begin("A");
		send.finish();
		const [[afterBegin], [afterFinish]] = onChange.mock.calls;
		expect(afterBegin).not.toBe(afterFinish);
		expect(afterBegin.has("A")).toBe(true);
	});

	it("ignores a second finish of the same send", () => {
		const { tracker, onChange } = tracked();
		const send = tracker.begin("A");
		send.finish();
		send.finish();
		expect(onChange).toHaveBeenCalledTimes(2);
	});
});
