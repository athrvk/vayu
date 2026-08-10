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
 * The View menu's zoom items and the Appearance panel's scale must be the same
 * setting.
 *
 * Before this, the menu carried Chromium's `zoomIn`/`zoomOut`/`resetZoom`
 * roles: they compounded on top of the applied scale (the picker kept saying
 * "Default" while the window rendered 133%), nothing persisted them, and
 * `resetZoom` snapped to 100% in defiance of the saved setting. These cases
 * pin the replacement - the menu nudges the persisted setting and nothing else
 * touches the zoom.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { act } from "react";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import { UI_SCALE_MAX, UI_SCALE_MIN } from "@/constants/appearance";
import { useAppearanceStore } from "@/stores";
import { useMenuActions } from "./useMenuActions";

type ZoomCommand = "in" | "out" | "reset";

const listeners: ((command: ZoomCommand) => void)[] = [];
const setZoomFactor = vi.fn();

function Harness() {
	useMenuActions();
	return null;
}

/** Deliver a menu command exactly as the preload bridge would. */
function fireZoom(command: ZoomCommand) {
	act(() => {
		for (const listener of listeners) listener(command);
	});
}

beforeEach(() => {
	listeners.length = 0;
	setZoomFactor.mockClear();
	localStorage.clear();
	useAppearanceStore.setState({ scale: 1 });
	vi.stubGlobal("electronAPI", {
		setZoomFactor,
		onZoomCommand: (callback: (command: ZoomCommand) => void) => {
			listeners.push(callback);
			return () => {
				const at = listeners.indexOf(callback);
				if (at >= 0) listeners.splice(at, 1);
			};
		},
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("View menu zoom", () => {
	it("raises the persisted setting one step and applies it", () => {
		render(<Harness />);
		fireZoom("in");

		expect(useAppearanceStore.getState().scale).toBe(1.1);
		expect(localStorage.getItem(STORAGE_KEYS.UI_SCALE)).toBe("1.1");
		expect(setZoomFactor).toHaveBeenLastCalledWith(1.1);
	});

	it("lowers it one step the same way", () => {
		render(<Harness />);
		fireZoom("out");

		expect(useAppearanceStore.getState().scale).toBe(0.9);
		expect(localStorage.getItem(STORAGE_KEYS.UI_SCALE)).toBe("0.9");
		expect(setZoomFactor).toHaveBeenLastCalledWith(0.9);
	});

	it("steps without accumulating float drift", () => {
		render(<Harness />);
		fireZoom("out");
		fireZoom("out");

		// 1 - 0.1 - 0.1 is 0.7999999999999999 unrounded, which would both fail the
		// lower clamp and persist as a 17-digit string.
		expect(useAppearanceStore.getState().scale).toBe(0.8);
		expect(localStorage.getItem(STORAGE_KEYS.UI_SCALE)).toBe("0.8");
	});

	it("returns to the user's default on reset instead of ignoring the setting", () => {
		render(<Harness />);
		fireZoom("in");
		fireZoom("in");
		fireZoom("reset");

		expect(useAppearanceStore.getState().scale).toBe(1);
		expect(localStorage.getItem(STORAGE_KEYS.UI_SCALE)).toBe("1");
		expect(setZoomFactor).toHaveBeenLastCalledWith(1);
	});

	it("holds at both ends of the range", () => {
		render(<Harness />);

		useAppearanceStore.setState({ scale: UI_SCALE_MAX });
		fireZoom("in");
		expect(useAppearanceStore.getState().scale).toBe(UI_SCALE_MAX);

		useAppearanceStore.setState({ scale: UI_SCALE_MIN });
		fireZoom("out");
		expect(useAppearanceStore.getState().scale).toBe(UI_SCALE_MIN);
	});

	it("stops listening once unmounted", () => {
		const { unmount } = render(<Harness />);
		unmount();

		expect(listeners).toHaveLength(0);
	});

	it("is a no-op outside Electron", () => {
		vi.stubGlobal("electronAPI", undefined);
		expect(() => render(<Harness />)).not.toThrow();
		expect(useAppearanceStore.getState().scale).toBe(1);
	});
});
