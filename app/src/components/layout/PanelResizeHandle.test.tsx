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
			size={width}
			setSize={setWidth}
			defaultSize={260}
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
					size={startWidth}
					setSize={setWidth}
					defaultSize={260}
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
 * A held key auto-repeats every 30-100 ms (#1738) - slower than a frame, so a
 * per-frame coalesce still commits once per repeat. `layout-store` persists
 * synchronously, so that is a `JSON.stringify` + `localStorage.setItem` per
 * repeat. A single press still commits immediately (kept identical to the
 * tests above); a *held* key's repeats are throttled on time.
 */
describe("PanelResizeHandle - keyboard repeat", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("throttles repeats spaced across frames to one commit per interval", () => {
		vi.useFakeTimers();
		const { setWidth, handle } = setup("right");

		// Ten repeats 40 ms apart (a realistic OS repeat rate), each far
		// longer than a 16 ms frame. Mutation check: coalesce per frame
		// instead of per interval, or drop the `e.repeat` branch, and this
		// sees one commit per repeat.
		for (let i = 0; i < 10; i++) {
			fireEvent.keyDown(handle, { key: "ArrowRight", repeat: true });
			vi.advanceTimersByTime(40);
		}

		expect(setWidth).toHaveBeenCalledTimes(2);
		// The first window's tail: five nudges of 16 from the 300 start.
		expect(setWidth.mock.calls[0][0]).toBe(380);
	});

	it("flushes a still-pending repeat on key release rather than dropping it", () => {
		vi.useFakeTimers();
		const { setWidth, handle } = setup("right");

		fireEvent.keyDown(handle, { key: "ArrowRight", repeat: true });
		expect(setWidth).not.toHaveBeenCalled();
		fireEvent.keyUp(handle, { key: "ArrowRight" });

		expect(setWidth).toHaveBeenCalledWith(316);
		vi.advanceTimersByTime(1000);
		expect(setWidth).toHaveBeenCalledTimes(1);
	});
});

/**
 * The bottom panel's handle sits on the panel's top edge (#3635), so it is a
 * horizontal separator on the vertical axis, with bounds of its own. Pointer
 * up and ArrowUp grow the panel - the mirror of the left-edge handle, turned a
 * quarter - and what it resizes is the panel's height, painted onto
 * `style.height`, never `style.width`.
 */
describe("PanelResizeHandle - top edge", () => {
	const MIN = 120;
	const MAX = 400;

	function setupTop(size = 240) {
		const setSize = vi.fn();
		const { container } = render(
			<div style={{ height: size }}>
				<PanelResizeHandle
					side="top"
					size={size}
					setSize={setSize}
					defaultSize={200}
					label="Resize bottom panel"
					min={MIN}
					max={MAX}
				/>
			</div>
		);
		return {
			setSize,
			handle: screen.getByRole("separator"),
			panel: container.firstElementChild as HTMLElement,
		};
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("is a horizontal separator announcing the bounds it was given", () => {
		const { handle } = setupTop();
		expect(handle).toHaveAttribute("aria-orientation", "horizontal");
		expect(handle).toHaveAttribute("aria-valuenow", "240");
		expect(handle).toHaveAttribute("aria-valuemin", String(MIN));
		expect(handle).toHaveAttribute("aria-valuemax", String(MAX));
	});

	it("keeps the side handles vertical separators with the panel-width bounds", () => {
		expect(setup("right").handle).toHaveAttribute("aria-orientation", "vertical");
	});

	it("grows on ArrowUp and shrinks on ArrowDown - the edge follows the key", () => {
		const { setSize, handle } = setupTop();
		fireEvent.keyDown(handle, { key: "ArrowUp" });
		expect(setSize).toHaveBeenCalledWith(256);
		fireEvent.keyUp(handle, { key: "ArrowUp" });
		fireEvent.keyDown(handle, { key: "ArrowDown" });
		expect(setSize).toHaveBeenLastCalledWith(224);
	});

	it("jumps with Page keys, PageUp growing", () => {
		const { setSize, handle } = setupTop();
		fireEvent.keyDown(handle, { key: "PageUp" });
		expect(setSize).toHaveBeenCalledWith(304);
		fireEvent.keyUp(handle, { key: "PageUp" });
		fireEvent.keyDown(handle, { key: "PageDown" });
		expect(setSize).toHaveBeenLastCalledWith(176);
	});

	it("sends Home and End to the bounds it announces, and Enter to the reset", () => {
		const { setSize, handle } = setupTop();
		fireEvent.keyDown(handle, { key: "Home" });
		expect(setSize).toHaveBeenLastCalledWith(MIN);
		fireEvent.keyDown(handle, { key: "End" });
		expect(setSize).toHaveBeenLastCalledWith(MAX);
		fireEvent.keyDown(handle, { key: "Enter" });
		expect(setSize).toHaveBeenLastCalledWith(200);
	});

	it("clamps a nudge at the bounds it was given", () => {
		const { setSize, handle } = setupTop(MAX - 4);
		fireEvent.keyDown(handle, { key: "ArrowUp" });
		expect(setSize).toHaveBeenLastCalledWith(MAX);
	});

	it("ignores the horizontal arrows, which belong to the side handles", () => {
		const { setSize, handle } = setupTop();
		fireEvent.keyDown(handle, { key: "ArrowLeft" });
		fireEvent.keyDown(handle, { key: "ArrowRight" });
		expect(setSize).not.toHaveBeenCalled();
	});

	it("ignores the vertical arrows on a side handle", () => {
		const { setWidth, handle } = setup("right");
		fireEvent.keyDown(handle, { key: "ArrowUp" });
		fireEvent.keyDown(handle, { key: "ArrowDown" });
		expect(setWidth).not.toHaveBeenCalled();
	});

	describe("by pointer", () => {
		beforeEach(() => {
			stubAnimationFrame();
		});

		it("widens upward: dragging the pointer up paints a taller panel and commits once", async () => {
			const { setSize, handle, panel } = setupTop(240);

			fireEvent.pointerDown(handle, { clientY: 500, pointerId: 1 });
			fireEvent.pointerMove(window, { clientY: 450 });
			await flushAnimationFrame();

			expect(panel.style.height).toBe("290px");
			expect(panel.style.width).toBe("");
			expect(handle).toHaveAttribute("aria-valuenow", "290");
			expect(setSize).not.toHaveBeenCalled();

			fireEvent.pointerUp(window);
			expect(setSize).toHaveBeenCalledTimes(1);
			expect(setSize).toHaveBeenCalledWith(290);
		});

		it("shrinks when the pointer moves down, and clamps at the given bounds", async () => {
			const { setSize, handle, panel } = setupTop(240);

			fireEvent.pointerDown(handle, { clientY: 500, pointerId: 1 });
			fireEvent.pointerMove(window, { clientY: 560 });
			await flushAnimationFrame();
			expect(panel.style.height).toBe("180px");

			fireEvent.pointerMove(window, { clientY: 5000 });
			await flushAnimationFrame();
			expect(panel.style.height).toBe(`${MIN}px`);

			fireEvent.pointerMove(window, { clientY: -5000 });
			await flushAnimationFrame();
			expect(panel.style.height).toBe(`${MAX}px`);

			fireEvent.pointerUp(window);
			expect(setSize).toHaveBeenCalledWith(MAX);
		});

		it("ignores horizontal movement, the axis it does not drag on", async () => {
			const { handle, panel } = setupTop(240);

			fireEvent.pointerDown(handle, { clientX: 100, clientY: 500, pointerId: 1 });
			fireEvent.pointerMove(window, { clientX: 400, clientY: 500 });
			await flushAnimationFrame();

			expect(panel.style.height).toBe("240px");
			fireEvent.pointerUp(window);
		});
	});
});
