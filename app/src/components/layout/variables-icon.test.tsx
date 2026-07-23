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
 * "Variables" is drawn one way, and that way is `{}`.
 *
 * The Dock used `Zap`, which is this app's load-test mark everywhere else - the
 * Load Test button in the URL bar, the dashboard tab icon, the badge on a load
 * run in History. In the Dock it promised "run" and opened a variable editor.
 *
 * Swapping only the Dock would have left the concept drawn three ways, since
 * the welcome Launcher used `Database` and the variables empty state used
 * `Variable`. So this pins the association, not just the glyph: the thing
 * labelled "Variables" carries `Braces`, in all three places, and carries no
 * icon that means something else in the app.
 *
 * Rendered rather than source-scanned. A scan would read `icon: <Braces …>` in
 * the Dock's `DRAWER_BUTTONS` happily enough, but the Launcher and the empty
 * state both hand their icon over as a *component reference* (`icon={Braces}`)
 * that a sibling renders - the class never appears as text next to the word
 * "Variables", which is precisely the blind spot CLAUDE.md records from the
 * badge-hover guard.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Dock } from "./Dock";
import { TabStrip } from "./TabStrip";
import { Launcher } from "@/modules/welcome/Launcher";
import VariablesMain from "@/modules/variables/main/VariablesMain";
import { useTabsStore } from "@/stores";

// The Dock prints the app version, which Vite `define`s at build time; vitest
// does not, so without this the component throws before it renders an icon.
vi.stubGlobal("__VAYU_VERSION__", "0.0.0-test");

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({ data: [], isLoading: false, isError: false }),
	useEnvironmentsQuery: () => ({ data: [], isLoading: false, isError: false }),
	useGlobalsQuery: () => ({ data: undefined, isLoading: false, error: null }),
	useRequestQuery: () => ({ data: undefined, isLoading: false, isError: false }),
	useRunQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));

vi.mock("@/modules/variables/variables-store", () => ({
	useVariablesStore: () => ({ selectedCategory: null }),
}));

/**
 * lucide stamps each icon with `lucide-<kebab-name>` alongside the shared
 * `lucide` class, so the glyph is identifiable from the DOM. Returns the names
 * without the prefix.
 */
function iconNames(root: Element): string[] {
	return Array.from(root.querySelectorAll("svg"))
		.flatMap((svg) => svg.getAttribute("class")?.split(/\s+/) ?? [])
		.filter((c) => c.startsWith("lucide-"))
		.map((c) => c.slice("lucide-".length));
}

beforeEach(cleanup);

describe("the variables icon", () => {
	it("is Braces in the Dock, not the load-test bolt", () => {
		render(<Dock />);
		const button = screen.getByRole("button", { name: "Variables" });

		const names = iconNames(button);
		// Guards the reader: a renamed class or an icon-less button would make
		// every assertion below vacuous.
		expect(names.length).toBeGreaterThan(0);
		expect(names).toContain("braces");
		expect(names).not.toContain("zap");
	});

	it("does not reuse an icon another Dock button already owns", () => {
		render(<Dock />);
		const nav = screen.getByRole("navigation", { name: "Sidebar views" });
		const buttons = Array.from(nav.querySelectorAll("button"));

		expect(buttons).toHaveLength(4);
		const perButton = buttons.map((b) => iconNames(b).join("+"));
		expect(new Set(perButton).size).toBe(perButton.length);
	});

	it("keeps the bolt out of the drawer switchers entirely", () => {
		// `Zap` means "load test" in this app. Any of the four wearing it would
		// re-introduce the same misreading in a different slot.
		render(<Dock />);
		const nav = screen.getByRole("navigation", { name: "Sidebar views" });
		expect(iconNames(nav)).not.toContain("zap");
	});

	it("survives the trip into the tab strip", () => {
		// The tab existed with no icon at all, so pressing a `Braces` control in
		// the Dock or on the Launcher opened a tab where the glyph had gone -
		// the one place the user looks to confirm what they just opened.
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "variables", entityId: null }],
			activeTabId: "t1",
		});
		render(<TabStrip />);
		const tab = screen.getByRole("tab", { name: /Variables/ });

		const names = iconNames(tab);
		expect(names).toContain("braces");
		expect(names).not.toContain("zap");
	});

	it("is the same glyph on the welcome Launcher's Variables tile", () => {
		render(
			<Launcher
				runs={[]}
				collectionCount={0}
				onImport={() => {}}
				onNewRequest={() => {}}
				onHistory={() => {}}
				onVariables={() => {}}
			/>
		);
		const tile = screen.getByRole("button", { name: /Variables/ });

		const names = iconNames(tile);
		expect(names.length).toBeGreaterThan(0);
		expect(names).toContain("braces");
		// The tile used to be a database cylinder - stored records, not `{{name}}`.
		expect(names).not.toContain("database");
	});

	it("is the same glyph on the variables empty state", () => {
		const { container } = render(<VariablesMain />);
		expect(screen.getByText("No category selected")).toBeInTheDocument();

		const names = iconNames(container);
		expect(names.length).toBeGreaterThan(0);
		expect(names).toContain("braces");
		// lucide's own `Variable` - `(x)` - is maths notation, and its centre
		// crossing is ~4px of detail at the 16px the Dock renders at.
		expect(names).not.toContain("variable");
	});
});
