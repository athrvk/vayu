/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SettingsCategoryTree from "./SettingsCategoryTree";
import { useTabsStore } from "@/stores";
import { useSettingsStore } from "@/modules/settings/settings-store";
import { APP_SETTINGS_PANELS } from "@/modules/settings/main/app-panels";
import { ENGINE_SETTINGS_CATEGORIES } from "@/modules/settings/engine-categories";

const refetch = vi.fn();
const configQuery = {
	data: undefined as unknown,
	isLoading: false,
	error: null as Error | null,
	refetch,
};

// The engine /config query is irrelevant to the App Settings rows below - those
// render client-side - but the Engine Settings section is driven entirely by it.
vi.mock("@/queries", () => ({
	useConfigQuery: () => configQuery,
}));

function renderTree() {
	const qc = new QueryClient();
	return render(
		<QueryClientProvider client={qc}>
			<SettingsCategoryTree />
		</QueryClientProvider>
	);
}

describe("SettingsCategoryTree", () => {
	beforeEach(() => {
		refetch.mockClear();
		configQuery.data = undefined;
		configQuery.isLoading = false;
		configQuery.error = null;
		useTabsStore.setState({ openTabs: [], activeTabId: null });
		useSettingsStore.setState({ selectedCategory: null });
	});

	// The tree now lives in the Drawer, so selecting a category must open the
	// settings tab itself (it used to be rendered inside that tab).
	it("selects the category and opens the settings tab", () => {
		renderTree();
		fireEvent.click(screen.getByRole("button", { name: /Appearance/i }));

		expect(useSettingsStore.getState().selectedCategory).toBe("appearance");
		const { openTabs } = useTabsStore.getState();
		expect(openTabs).toHaveLength(1);
		expect(openTabs[0].type).toBe("settings");
	});

	/*
	 * The engine section used to fail into a static two-line notice. The engine
	 * is a sidecar that restarts, so "unavailable" is routinely temporary - but
	 * nothing in the sidebar re-asked, leaving app relaunch as the only recovery.
	 */
	it("offers a retry when the engine settings fail to load", () => {
		configQuery.error = new Error("connect ECONNREFUSED 127.0.0.1:9876");
		renderTree();

		expect(screen.getByText(/couldn't load engine settings/i)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: /try again/i }));
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	// App Settings are client-side; a dead engine must not take them with it.
	it("keeps the App Settings rows usable while the engine is down", () => {
		configQuery.error = new Error("engine down");
		renderTree();

		expect(screen.getByRole("button", { name: /Appearance/i })).toBeTruthy();
	});
});

/**
 * The category rows are navigation affordances, so their glyphs answer a hover
 * the way the Activity Rail's six do (#1707). They were missed when the rest of
 * the app got its motions, which is the whole reason this block exists: the
 * failure mode is silence, not a broken row.
 *
 * Two halves, and the second is the one worth keeping: a glyph *offering* an
 * action animates, and the same glyph *reporting* which panel you are on does
 * not (docs/design-system.md, Icon motion).
 */
describe("SettingsCategoryTree - icon motion from the registries (#1707)", () => {
	beforeEach(() => {
		refetch.mockClear();
		configQuery.data = undefined;
		configQuery.isLoading = false;
		configQuery.error = null;
		useTabsStore.setState({ openTabs: [], activeTabId: null });
		useSettingsStore.setState({ selectedCategory: null });
	});

	/** The `data-icon-motion` on one row's glyph, or `null` for none. */
	function motionOf(label: string): string | null {
		const svg = screen.getByRole("button", { name: label }).querySelector("svg");
		expect(svg, `${label} rendered no glyph`).not.toBeNull();
		return svg?.getAttribute("data-icon-motion") ?? null;
	}

	it("gives every category row a motion, from whichever registry owns it", () => {
		renderTree();
		// Against the registries rather than a list written here, so a
		// sixteenth category added without a motion fails instead of shipping
		// a row whose glyph is the only still one in the drawer.
		const all = [
			...APP_SETTINGS_PANELS.map((p) => [p.label, p.motion] as const),
			...ENGINE_SETTINGS_CATEGORIES.map((c) => [c.label, c.motion] as const),
		];
		expect(all.length).toBeGreaterThan(14);
		for (const [label, motion] of all) {
			expect(motion, `${label} names no motion`).toBeDefined();
			expect(motionOf(label), label).toBe(motion);
		}
	});

	it("gives each row the group owner its glyph's motion fires from", () => {
		// Every rule in the `Icon motion` block keys off a `[data-slot="button"]`
		// or `.group` ancestor's hover, and this row is a hand-rolled `<button>`
		// that is neither. Dropping the class leaves fifteen attributes wired to
		// nothing, which renders perfectly.
		renderTree();
		const row = screen.getByRole("button", { name: /Appearance/i });
		expect(row.className.split(/\s+/)).toContain("group");
	});

	it("draws the same glyph still where it reports rather than offers", () => {
		// The "Engine Settings" heading carries `Settings` as a label for the
		// section, not as a control - and `SettingsMain`'s own page header
		// draws no category glyph at all. Neither may carry the attribute: a
		// heading that animates under a passing pointer invites a click on
		// something that is not there.
		const { container } = renderTree();
		const rowGlyphs = new Set([...container.querySelectorAll("button svg")].map((el) => el));
		const outsideARow = [...container.querySelectorAll("svg")].filter(
			(el) => !rowGlyphs.has(el)
		);
		expect(
			outsideARow.length,
			"no glyph outside a row, so this proves nothing"
		).toBeGreaterThan(0);
		for (const glyph of outsideARow) {
			expect(
				glyph.hasAttribute("data-icon-motion"),
				"a glyph outside a row carries data-icon-motion"
			).toBe(false);
		}
	});
});
