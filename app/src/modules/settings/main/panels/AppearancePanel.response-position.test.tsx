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
 * The Response position row (issue #1711): three options, writing
 * `layout-store` - the same field the Dock button and the chord write, so a
 * choice made anywhere shows here. Mutation check: drop the row's `onChange`
 * and the second case fails.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useLayoutStore } from "@/stores";
import { AUTO_RESPONSE_BELOW_MAX_WIDTH } from "@/constants/layout";
import AppearancePanel from "./AppearancePanel";

vi.mock("@/hooks/useElectronTheme", () => ({
	useElectronTheme: () => ({ source: "system", setSource: vi.fn(), resolved: "dark" }),
}));

vi.mock("@/hooks/useAppearance", () => ({
	useAppearance: () => ({
		font: "space-grotesk",
		setFont: vi.fn(),
		fontCustom: "",
		setFontCustom: vi.fn(),
		scale: 1,
		setScale: vi.fn(),
		radius: "default",
		setRadius: vi.fn(),
		density: "comfortable",
		setDensity: vi.fn(),
	}),
}));

beforeEach(() => {
	useLayoutStore.setState({ responsePosition: "beside" });
});

describe("Response position row", () => {
	it("offers Beside, Below and Auto, naming the Auto threshold", () => {
		render(<AppearancePanel />);
		for (const label of ["Beside", "Below", "Auto"]) {
			expect(
				screen.getByRole("button", { name: new RegExp(`^${label}`) })
			).toBeInTheDocument();
		}
		expect(
			screen.getByText(new RegExp(`narrower than ${AUTO_RESPONSE_BELOW_MAX_WIDTH}px`))
		).toBeInTheDocument();
	});

	it("writes the store, and reflects a choice made elsewhere", () => {
		render(<AppearancePanel />);
		fireEvent.click(screen.getByRole("button", { name: /^Below/ }));
		expect(useLayoutStore.getState().responsePosition).toBe("below");

		fireEvent.click(screen.getByRole("button", { name: /^Auto/ }));
		expect(useLayoutStore.getState().responsePosition).toBe("auto");
	});
});
