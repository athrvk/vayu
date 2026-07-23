/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TabStrip } from "./TabStrip";
import { useTabsStore } from "@/stores";
import collectionItemSrc from "@/modules/collections/CollectionItem.tsx?raw";
import requestItemSrc from "@/modules/collections/RequestItem.tsx?raw";

vi.mock("@/queries", () => ({
	useRequestQuery: () => ({ data: undefined }),
	useRunQuery: () => ({ data: undefined }),
	useCollectionsQuery: () => ({ data: [] }),
}));

vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({ resolveString: (s: string) => s }),
}));

function renderTabStrip() {
	const qc = new QueryClient();
	return render(
		<QueryClientProvider client={qc}>
			<TabStrip />
		</QueryClientProvider>
	);
}

describe("focus containers", () => {
	beforeEach(() => {
		useTabsStore.setState({ openTabs: [], activeTabId: null });
	});

	// The tab row clips horizontally (overflow-x-auto) and tabs are h-full, so
	// an outset focus ring would be cut off. .panel-clip tucks it inward for
	// every focusable descendant - dropping it silently clips the ring.
	it("marks the tab row as a clipping panel", () => {
		renderTabStrip();
		expect(screen.getByRole("tablist")).toHaveClass("panel-clip");
	});

	// Tree rows are wider than the label button inside them, so the row paints
	// the focus ring (at its own radius, with the accent fill). Losing the
	// marker sends the ring back to the narrow, square-cornered inner button.
	// Matches the leading class string, not a bare mention, so the explanatory
	// comment in those files cannot satisfy this on its own.
	it.each([
		["CollectionItem", collectionItemSrc],
		["RequestItem", requestItemSrc],
	])("keeps focus-row on the %s row", (_name, src) => {
		expect(src).toMatch(/["'`]focus-row\s+flex/);
	});

	// The disclosure chevron toggles expansion rather than opening the
	// collection, so it keeps its own ring and opts out of lighting the row.
	// Without focus-self both indicators show at once.
	it("keeps focus-self on the disclosure chevron", () => {
		expect(collectionItemSrc).toMatch(/["'`]focus-self\s+flex/);
	});

	it("keeps tabs reachable by keyboard and close controls out of tab order", () => {
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "welcome", entityId: null }],
			activeTabId: "t1",
		});
		renderTabStrip();

		const tab = screen.getByRole("tab");
		expect(tab).toHaveAttribute("tabindex", "0");
		tab.focus();
		expect(document.activeElement).toBe(tab);

		// Deliberate: a tab stop per close button makes tabbing noisy, and
		// Cmd/Ctrl+W already closes the active tab.
		expect(screen.getByLabelText("Close tab")).toHaveAttribute("tabindex", "-1");
	});
});
