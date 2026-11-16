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
 * The drawer's push and overlay boxes (#3494).
 *
 * Classes, not geometry: jsdom has no layout, so "floats over the content" is
 * asserted as the positioning that produces it. The views are stubbed - which
 * one shows is not this file's subject.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Drawer } from "./Drawer";
import { useLayoutStore } from "@/stores";
import type { SidePanelMode } from "@/constants/layout";

vi.mock("@/modules/collections/CollectionTree", () => ({ default: () => <p>tree</p> }));
vi.mock("@/modules/history/sidebar/HistoryList", () => ({ default: () => null }));
vi.mock("@/modules/variables/sidebar/VariablesCategoryTree", () => ({ default: () => null }));
vi.mock("@/modules/settings/sidebar/SettingsCategoryTree", () => ({ default: () => null }));
vi.mock("@/modules/services", () => ({ ServicesPanel: () => null }));
vi.mock("@/modules/trash", () => ({ TrashList: () => null }));

function drawer(mode?: SidePanelMode): HTMLElement {
	render(<Drawer mode={mode} />);
	return screen.getByRole("complementary", { name: "Collections sidebar" });
}

beforeEach(() => {
	useLayoutStore.setState({ drawerOpen: true, drawerView: "collections", drawerWidth: 300 });
});

describe("Drawer - push and overlay modes", () => {
	it("floats over the content's left edge in overlay mode", () => {
		const className = drawer("overlay").className;
		// The context bar's overlay set, on the other edge: the two panels read
		// as one family, and the shared z-index keeps either from being buried.
		for (const cls of [
			"absolute",
			"left-0",
			"top-0",
			"bottom-0",
			"max-w-full",
			"shadow-lg",
			"z-10",
		]) {
			expect(className.split(/\s+/)).toContain(cls);
		}
		expect(className).not.toContain("relative");
	});

	it("takes layout space in push mode", () => {
		const className = drawer("push").className;
		expect(className.split(/\s+/)).toContain("relative");
		expect(className).not.toContain("absolute");
		expect(className).not.toContain("shadow-lg");
	});

	it("pushes when no mode is given", () => {
		expect(drawer().className).not.toContain("absolute");
	});

	it("keeps its width, its collapse animation and its resize handle in both modes", () => {
		for (const mode of ["push", "overlay"] as const) {
			const { unmount } = render(<Drawer mode={mode} />);
			const aside = screen.getByRole("complementary", { name: "Collections sidebar" });
			expect(aside.style.width).toBe("300px");
			expect(aside.className).toContain("rail-collapse");
			expect(aside.contains(screen.getByRole("separator"))).toBe(true);
			unmount();
		}
	});
});
