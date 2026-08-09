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
 * The Scale control must always describe the size the window is actually drawn
 * at. The three-step picker it replaced could not: a Ctrl+= from the View menu
 * moved the zoom and left the picker reading "Default".
 *
 * These cases go through the real store rather than a mocked `useAppearance`,
 * because the thing under test is precisely that the panel and the menu share
 * one value.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { act } from "react";
import { UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP } from "@/constants/appearance";
import { useAppearanceStore } from "@/stores";
import AppearancePanel from "./AppearancePanel";

vi.mock("@/hooks/usePrefersReducedMotion", () => ({
	usePrefersReducedMotion: () => false,
}));

vi.mock("@/hooks/useElectronTheme", () => ({
	useElectronTheme: () => ({ source: "system", setSource: vi.fn(), resolved: "dark" }),
}));

beforeEach(() => {
	localStorage.clear();
	useAppearanceStore.setState({ scale: 1 });
	vi.stubGlobal("electronAPI", undefined);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function slider(): HTMLInputElement {
	return screen.getByRole("slider", { name: /Interface scale/i });
}

describe("Appearance panel - interface scale", () => {
	it("offers the whole accessibility range, not three fixed steps", () => {
		render(<AppearancePanel />);

		expect(slider().min).toBe(String(UI_SCALE_MIN * 100));
		expect(slider().max).toBe(String(UI_SCALE_MAX * 100));
		expect(slider().step).toBe(String(UI_SCALE_STEP * 100));
	});

	it("shows the live value as a percentage", () => {
		useAppearanceStore.setState({ scale: 1.4 });
		render(<AppearancePanel />);

		expect(slider().value).toBe("140");
		expect(screen.getByText("140%")).toBeInTheDocument();
	});

	it("reflects a zoom nudge that came from the menu, not the panel", () => {
		render(<AppearancePanel />);
		expect(screen.getByText("100%")).toBeInTheDocument();

		// What the View menu's Ctrl+= does. The panel is not the one changing it.
		act(() => useAppearanceStore.getState().nudgeScale(1));

		expect(screen.getByText("110%")).toBeInTheDocument();
		expect(slider().value).toBe("110");
	});

	it("persists a drag of the slider", () => {
		render(<AppearancePanel />);
		fireEvent.change(slider(), { target: { value: "150" } });

		expect(useAppearanceStore.getState().scale).toBe(1.5);
	});

	it("offers Reset only when the scale is not already the default", () => {
		render(<AppearancePanel />);
		const reset = screen.getByRole("button", { name: /^Reset$/ });
		expect(reset).toBeDisabled();

		act(() => useAppearanceStore.getState().setScale(1.6));
		expect(reset).toBeEnabled();

		fireEvent.click(reset);
		expect(useAppearanceStore.getState().scale).toBe(1);
		expect(screen.getByText("100%")).toBeInTheDocument();
	});

	it("points at the separate control for code font size", () => {
		render(<AppearancePanel />);
		expect(screen.getByText(/Code font size is a separate control/i)).toBeInTheDocument();
	});
});
