import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TabStrip } from "./TabStrip";
import { useTabsStore } from "@/stores";

vi.mock("@/queries", () => ({
	useRequestQuery: () => ({ data: undefined }),
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
	// every focusable descendant — dropping it silently clips the ring.
	it("marks the tab row as a clipping panel", () => {
		renderTabStrip();
		expect(screen.getByRole("tablist")).toHaveClass("panel-clip");
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
