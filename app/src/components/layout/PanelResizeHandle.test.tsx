/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The drawer and context-bar handles were mouse-only.
 *
 * Both were a bare `<div>` with `onPointerDown` and `onDoubleClick` — no role,
 * no tabindex, no keys — so the two panels framing the whole app could not be
 * resized or reset from the keyboard. They also had separate copies of the same
 * logic, one of them commented as mirroring the other.
 *
 * `side` is the part worth testing hardest: the drawer's handle is on its right
 * edge so ArrowRight widens, the context bar's is on its left so ArrowLeft
 * widens. Getting that inverted would be easy and would feel broken rather than
 * look broken.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { PANEL_MIN_WIDTH, PANEL_MAX_WIDTH } from "@/constants/layout";

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
		fireEvent.keyDown(handle, { key: "ArrowLeft" });
		expect(setWidth).toHaveBeenLastCalledWith(284);
	});

	it("widens leftwards for a left-edge handle — the direction is inverted", () => {
		const { setWidth, handle } = setup("left");
		fireEvent.keyDown(handle, { key: "ArrowLeft" });
		expect(setWidth).toHaveBeenCalledWith(316);
		fireEvent.keyDown(handle, { key: "ArrowRight" });
		expect(setWidth).toHaveBeenLastCalledWith(284);
	});

	it("jumps with Page keys", () => {
		const { setWidth, handle } = setup("right");
		fireEvent.keyDown(handle, { key: "PageUp" });
		expect(setWidth).toHaveBeenCalledWith(364);
		fireEvent.keyDown(handle, { key: "PageDown" });
		expect(setWidth).toHaveBeenLastCalledWith(236);
	});

	it("sends Home and End to the bounds, which the store clamps", () => {
		const { setWidth, handle } = setup("right");
		fireEvent.keyDown(handle, { key: "Home" });
		expect(setWidth).toHaveBeenCalledWith(-Infinity);
		fireEvent.keyDown(handle, { key: "End" });
		expect(setWidth).toHaveBeenLastCalledWith(Infinity);
	});

	it("resets on Enter and Space — the double-click had no keyboard route", () => {
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

	it("shows a focus state — an 8px strip with no content is otherwise unfindable", () => {
		const { handle } = setup("right");
		expect(handle.className).toContain("focus-visible:");
	});
});
