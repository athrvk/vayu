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

	it("cancel aborts a cancellable send and idles its request at once", () => {
		const { tracker, latest } = tracked();
		const send = tracker.begin("A", { cancellable: true });
		expect(latest()?.get("A")?.cancellable).toBe(true);

		tracker.cancel("A");
		expect(send.signal.aborted).toBe(true);
		expect(send.isCurrent()).toBe(false);
		expect(latest()?.has("A")).toBe(false);
	});

	it("leaves the cancelled send's own finish nothing to do", () => {
		const { tracker, onChange } = tracked();
		const send = tracker.begin("A", { cancellable: true });
		tracker.cancel("A");
		const changes = onChange.mock.calls.length;

		send.finish();
		expect(onChange.mock.calls.length).toBe(changes);
	});

	it("does not cancel a send that was not begun cancellable", () => {
		const { tracker, latest } = tracked();
		const send = tracker.begin("A");
		tracker.cancel("A");
		expect(send.signal.aborted).toBe(false);
		expect(latest()?.has("A")).toBe(true);
	});

	it("cancels only the named request's send", () => {
		const { tracker, latest } = tracked();
		const a = tracker.begin("A", { cancellable: true });
		const b = tracker.begin("B", { cancellable: true });
		tracker.cancel("A");
		expect(a.signal.aborted).toBe(true);
		expect(b.signal.aborted).toBe(false);
		expect(latest()?.has("B")).toBe(true);
	});
});
