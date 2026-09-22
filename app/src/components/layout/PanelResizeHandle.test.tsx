/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The drawer and context-bar handles were mouse-only.
 *
 * Both were a bare `<div>` with `onPointerDown` and `onDoubleClick` - no role,
 * no tabindex, no keys - so the two panels framing the whole app could not be
 * resized or reset from the keyboard. They also had separate copies of the same
 * logic, one of them commented as mirroring the other.
 *
 * `side` is the part worth testing hardest: the drawer's handle is on its right
 * edge so ArrowRight widens, the context bar's is on its left so ArrowLeft
 * widens. Getting that inverted would be easy and would feel broken rather than
 * look broken.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { PANEL_MIN_WIDTH, PANEL_MAX_WIDTH } from "@/constants/layout";

/**
 * The drag path coalesces to one DOM write per animation frame (#1715), so a
 * drag's assertions need `requestAnimationFrame` to actually run a callback -
 * jsdom does not schedule one on its own. Stubbed onto a macrotask rather than
 * left to fire on a real frame, the same substitution `ContextRail.scroll.
 * test.tsx` uses and explains: a `setTimeout` still runs after the pointermove
 * handler returns, which is the ordering a real frame guarantees too.
 */
function stubAnimationFrame() {
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
		return setTimeout(() => cb(0), 0) as unknown as number;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
}

async function flushAnimationFrame() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function setup(side: "left" | "right", width = 300) {
	const setWidth = vi.fn();
	render(
		<PanelResizeHandle
			side={side}
			width={width}
			setWidth={setWidth}
			defaultWidth={260}
			label={side === "right" ? "Resize sidebar" : "Resize context bar"}
		/>
	);
	return { setWidth, handle: screen.getByRole("separator") };
}

describe("PanelResizeHandle", () => {
	it("is focusable and reports its position", () => {
		const { handle } = setup("right");
		expect(handle).toHaveAttribute("tabindex", "0");
		expect(handle).toHaveAttribute("aria-valuenow", "300");
		expect(handle).toHaveAttribute("aria-valuemin", String(PANEL_MIN_WIDTH));
		expect(handle).toHaveAttribute("aria-valuemax", String(PANEL_MAX_WIDTH));
	});

	it("is named, so the two handles are distinguishable when focused", () => {
		expect(setup("right").handle).toHaveAttribute("aria-label", "Resize sidebar");
		expect(screen.getAllByRole("separator")).toHaveLength(1);
	});

	it("widens rightwards for a right-edge handle", () => {
		const { setWidth, handle } = setup("right");
		fireEvent.keyDown(handle, { key: "ArrowRight" });
		expect(setWidth).toHaveBeenCalledWith(316);
		// A real release between two independent presses - a held key's own
		// repeats keep nudging from the last one (below), but a fresh press
		// after release always nudges from the actual current width again.
		fireEvent.keyUp(handle, { key: "ArrowRight" });
		fireEvent.keyDown(handle, { key: "ArrowLeft" });
		expect(setWidth).toHaveBeenLastCalledWith(284);
	});

	it("widens leftwards for a left-edge handle - the direction is inverted", () => {
		const { setWidth, handle } = setup("left");
		fireEvent.keyDown(handle, { key: "ArrowLeft" });
		expect(setWidth).toHaveBeenCalledWith(316);
		fireEvent.keyUp(handle, { key: "ArrowLeft" });
		fireEvent.keyDown(handle, { key: "ArrowRight" });
		expect(setWidth).toHaveBeenLastCalledWith(284);
	});

	it("jumps with Page keys", () => {
		const { setWidth, handle } = setup("right");
		fireEvent.keyDown(handle, { key: "PageUp" });
		expect(setWidth).toHaveBeenCalledWith(364);
		fireEvent.keyUp(handle, { key: "PageUp" });
		fireEvent.keyDown(handle, { key: "PageDown" });
		expect(setWidth).toHaveBeenLastCalledWith(236);
	});

	// Home and End are absolute against the declared value model, not spatial like
	// the arrows - so unlike the arrow cases above they must agree on both sides.
	// Pinning only `side="right"` is how the inverted mapping shipped green: there
	// the spatial and the absolute reading happen to coincide.
	it.each(["right", "left"] as const)(
		"sends Home to the min it announces and End to the max, on a %s-edge handle",
		(side) => {
			const { setWidth, handle } = setup(side);
			// Read the bounds off the element rather than the constants: the defect
			// was the keys disagreeing with the model the handle announces, so the
			// announcement is what the assertion has to be anchored to.
			expect(handle).toHaveAttribute("aria-valuemin", String(PANEL_MIN_WIDTH));
			expect(handle).toHaveAttribute("aria-valuemax", String(PANEL_MAX_WIDTH));

			fireEvent.keyDown(handle, { key: "Home" });
			expect(setWidth).toHaveBeenCalledWith(Number(handle.getAttribute("aria-valuemin")));
			fireEvent.keyDown(handle, { key: "End" });
			expect(setWidth).toHaveBeenLastCalledWith(Number(handle.getAttribute("aria-valuemax")));
		}
	);

	it("resets on Enter and Space - the double-click had no keyboard route", () => {
		const { setWidth, handle } = setup("right");
		fireEvent.keyDown(handle, { key: "Enter" });
		expect(setWidth).toHaveBeenCalledWith(260);
		fireEvent.keyDown(handle, { key: " " });
		expect(setWidth).toHaveBeenLastCalledWith(260);
	});

	it("ignores keys it does not own", () => {
		const { setWidth, handle } = setup("right");
		fireEvent.keyDown(handle, { key: "ArrowUp" });
		fireEvent.keyDown(handle, { key: "a" });
		expect(setWidth).not.toHaveBeenCalled();
	});

	it("shows a focus state - an 8px strip with no content is otherwise unfindable", () => {
		const { handle } = setup("right");
		expect(handle.className).toContain("focus-visible:");
	});
});

/**
 * A pointer drag used to call `setWidth` on every `pointermove` - a store
 * write, a re-render of every `layout-store` subscriber, and a synchronous
 * `localStorage.setItem` of the whole persisted slice, 120-240 times a second
 * (#1715). The fix keeps the drag's live width out of the store until
 * `pointerup`, painting it straight onto the panel's inline `style.width` -
 * the handle's own `parentElement`, which is what `Drawer` and `ContextBar`
 * both render it inside of - once per animation frame instead.
 */
describe("PanelResizeHandle - drag", () => {
	beforeEach(() => {
		stubAnimationFrame();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function setupDrag(side: "left" | "right" = "right", startWidth = 300) {
		const setWidth = vi.fn();
		const { container } = render(
			<div style={{ width: startWidth }}>
				<PanelResizeHandle
					side={side}
					width={startWidth}
					setWidth={setWidth}
					defaultWidth={260}
					label="Resize sidebar"
				/>
			</div>
		);
		const handle = screen.getByRole("separator");
		const panel = container.firstElementChild as HTMLElement;
		return { setWidth, handle, panel };
	}

	it("writes the store exactly once, on pointer up, with the final width", async () => {
		const { setWidth, handle } = setupDrag("right", 300);

		fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
		// A drag of N moves - well past what one animation frame could coalesce.
		for (let dx = 1; dx <= 40; dx++) {
			fireEvent.pointerMove(window, { clientX: 100 + dx });
		}
		await flushAnimationFrame();

		// Mutation check: restore the per-move `setWidth` call this test guards
		// against, and this assertion fails - `setWidth` would have been called
		// 40 times before `pointerup` ever fires.
		expect(setWidth).not.toHaveBeenCalled();

		fireEvent.pointerUp(window);

		expect(setWidth).toHaveBeenCalledTimes(1);
		expect(setWidth).toHaveBeenCalledWith(340);
	});

	it("tracks the pointer in the panel's inline width during the drag", async () => {
		const { handle, panel } = setupDrag("right", 300);

		fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
		fireEvent.pointerMove(window, { clientX: 150 });
		await flushAnimationFrame();

		// Painted straight onto the panel element, not routed through a store
		// write and a re-render - so this holds even though `setWidth` has not
		// been called yet.
		expect(panel.style.width).toBe("350px");
		expect(handle).toHaveAttribute("aria-valuenow", "350");

		fireEvent.pointerMove(window, { clientX: 180 });
		await flushAnimationFrame();
		expect(panel.style.width).toBe("380px");

		fireEvent.pointerUp(window);
	});

	it("inverts direction for a left-edge handle during a drag, same as the keyboard case", async () => {
		const { setWidth, panel } = setupDrag("left", 300);
		const handle = screen.getByRole("separator");

		fireEvent.pointerDown(handle, { clientX: 200, pointerId: 1 });
		fireEvent.pointerMove(window, { clientX: 150 });
		await flushAnimationFrame();
		expect(panel.style.width).toBe("350px");

		fireEvent.pointerUp(window);
		expect(setWidth).toHaveBeenCalledWith(350);
	});

	it("clamps the live width to the panel bounds during a drag", async () => {
		const { setWidth, panel } = setupDrag("right", 300);
		const handle = screen.getByRole("separator");

		fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
		fireEvent.pointerMove(window, { clientX: 100 + PANEL_MAX_WIDTH * 2 });
		await flushAnimationFrame();
		expect(panel.style.width).toBe(`${PANEL_MAX_WIDTH}px`);

		fireEvent.pointerUp(window);
		expect(setWidth).toHaveBeenCalledWith(PANEL_MAX_WIDTH);
	});

	it("keeps writing the store immediately on double-click, not just on drag end", () => {
		const { setWidth, handle } = setupDrag("right", 300);
		fireEvent.doubleClick(handle);
		expect(setWidth).toHaveBeenCalledWith(260);
	});

	// A touch interruption or an OS overlay taking the gesture mid-drag used
	// to leave the `pointermove`/`pointerup` listeners attached and the store
	// never written - `pointerup` just never came. `pointercancel` aborts
	// instead: the live preview reverts to where the drag started, and
	// nothing is committed, because the drag did not happen.
	it("aborts on pointercancel - the live width reverts and nothing is written", async () => {
		const { setWidth, panel } = setupDrag("right", 300);
		const handle = screen.getByRole("separator");

		fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
		fireEvent.pointerMove(window, { clientX: 150 });
		await flushAnimationFrame();
		expect(panel.style.width).toBe("350px");

		fireEvent.pointerCancel(window);

		expect(panel.style.width).toBe("300px");
		expect(setWidth).not.toHaveBeenCalled();
	});
});

/**
 * A held key auto-repeats roughly as fast as a drag fires `pointermove`
 * (#1738) - `layout-store` persists synchronously, so a naive per-repeat
 * `setWidth` is the same `JSON.stringify` + `localStorage.setItem` flood the
 * drag path was fixed for. A single press still commits immediately (kept
 * identical to the tests above); only a *held* key's repeats coalesce.
 */
describe("PanelResizeHandle - keyboard repeat", () => {
	function stubRafAsTimeout() {
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			return setTimeout(() => cb(0), 0) as unknown as number;
		});
		vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("coalesces a burst of repeats into one commit, landing on the last nudge", () => {
		vi.useFakeTimers();
		stubRafAsTimeout();
		const { setWidth, handle } = setup("right");

		fireEvent.keyDown(handle, { key: "ArrowRight", repeat: true });
		fireEvent.keyDown(handle, { key: "ArrowRight", repeat: true });
		fireEvent.keyDown(handle, { key: "ArrowRight", repeat: true });
		// Mutation check: remove the `e.repeat` branch in `useResizeGesture` so
		// every repeat commits straight away, and this fails - `setWidth` would
		// already have been called three times.
		expect(setWidth).not.toHaveBeenCalled();

		vi.runAllTimers();

		expect(setWidth).toHaveBeenCalledTimes(1);
		expect(setWidth).toHaveBeenCalledWith(348);

		vi.useRealTimers();
	});

	it("flushes a still-pending repeat on key release rather than dropping it", () => {
		vi.useFakeTimers();
		stubRafAsTimeout();
		const { setWidth, handle } = setup("right");

		fireEvent.keyDown(handle, { key: "ArrowRight", repeat: true });
		fireEvent.keyUp(handle, { key: "ArrowRight" });

		// Released before the coalesced frame ever fired - the value still
		// lands, immediately, rather than waiting for a frame that is now
		// cancelled.
		expect(setWidth).toHaveBeenCalledWith(316);

		vi.useRealTimers();
	});
});
