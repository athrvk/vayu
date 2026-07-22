/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A drag handle that only listens for the mouse is unusable from the keyboard,
 * and this is a tool for developers. `resizeBy` is the keyboard path: the body
 * editor's splitter wires arrows to a nudge, Page keys to a coarse jump, and
 * Home/End to ±Infinity, which clamp to the bounds.
 */

import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useResizable } from "./useResizable";

const opts = { defaultSize: 320, min: 160, max: 800, direction: "vertical" as const };

describe("useResizable - keyboard resizing", () => {
	it("nudges by a delta", () => {
		const { result } = renderHook(() => useResizable(opts));
		expect(result.current.size).toBe(320);

		act(() => result.current.resizeBy(24));
		expect(result.current.size).toBe(344);

		act(() => result.current.resizeBy(-48));
		expect(result.current.size).toBe(296);
	});

	// Note: this asserts the *observable* invariant, which the render-time clamp
	// on `size` already guarantees. Removing the clamp inside `resizeBy` does not
	// fail it - verified by mutation. The invariant is still worth pinning; just
	// do not read a pass here as covering that line.
	it("clamps to the same bounds a drag would", () => {
		const { result } = renderHook(() => useResizable(opts));

		act(() => result.current.resizeBy(-10_000));
		expect(result.current.size).toBe(160);

		act(() => result.current.resizeBy(10_000));
		expect(result.current.size).toBe(800);
	});

	it("treats ±Infinity as jump-to-extreme, so Home/End need no special case", () => {
		const { result } = renderHook(() => useResizable(opts));

		act(() => result.current.resizeBy(Infinity));
		expect(result.current.size).toBe(800);

		act(() => result.current.resizeBy(-Infinity));
		expect(result.current.size).toBe(160);
	});

	it("exposes the bounds, so a splitter can report aria-valuemin/max", () => {
		const { result } = renderHook(() => useResizable(opts));
		expect(result.current.min).toBe(160);
		expect(result.current.max).toBe(800);
	});

	it("nudges from the clamped size when the bounds have tightened", () => {
		// The panel can be sitting outside the current bounds - a per-context min
		// rises when a tab needs more room. A nudge should move from where the
		// panel actually is, not from the stale raw value.
		const { result, rerender } = renderHook(({ min }) => useResizable({ ...opts, min }), {
			initialProps: { min: 160 },
		});

		act(() => result.current.resizeBy(-Infinity));
		expect(result.current.size).toBe(160);

		rerender({ min: 400 });
		expect(result.current.size).toBe(400);

		act(() => result.current.resizeBy(24));
		expect(result.current.size).toBe(424);
	});
});
