/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Reduced motion row must not contradict what the user can see.
 *
 * Motion now also collapses for a system that asks for it, which means the
 * switch can read "off" while the app is visibly not animating. Saying so is
 * the whole point — the alternative leaves the user hunting for a bug in Vayu
 * that is really a setting in their OS.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import AppearancePanel from "./AppearancePanel";

const state = { osReduces: false };

vi.mock("@/hooks/usePrefersReducedMotion", () => ({
	usePrefersReducedMotion: () => state.osReduces,
}));

vi.mock("@/hooks/useElectronTheme", () => ({
	useElectronTheme: () => ({ source: "system", setSource: vi.fn(), resolved: "dark" }),
}));

vi.mock("@/hooks/useAppearance", () => ({
	useAppearance: () => ({
		font: "space-grotesk",
		setFont: vi.fn(),
		fontCustom: "",
		setFontCustom: vi.fn(),
		scale: "default",
		setScale: vi.fn(),
		radius: "default",
		setRadius: vi.fn(),
	}),
}));

beforeEach(() => {
	state.osReduces = false;
});

const NOTE = /system already asks for reduced motion/i;

describe("Reduced motion row", () => {
	it("says nothing extra when the system has no preference", () => {
		render(<AppearancePanel />);
		expect(screen.getByRole("switch", { name: /Reduced motion/i })).toBeInTheDocument();
		expect(screen.queryByText(NOTE)).toBeNull();
	});

	it("explains itself when the system is already asking", () => {
		state.osReduces = true;
		render(<AppearancePanel />);
		expect(screen.getByText(NOTE)).toBeInTheDocument();
		// The switch stays operable: turning it on still means something if the
		// system preference later changes.
		expect(screen.getByRole("switch", { name: /Reduced motion/i })).toBeEnabled();
	});
});
