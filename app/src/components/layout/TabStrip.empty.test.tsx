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
 * With no tabs open the strip says what to do (issue #1688).
 *
 * It used to be a blank 32px band with a lone "+" in it: a user whose last tab
 * had just closed was left with an empty window and no statement of where the
 * app went.
 *
 * **The strip is not collapsed, and that is the decision this file pins.** Its
 * height is the same `--tabstrip-height` the drawer's header band reads, so a
 * strip that disappeared would leave the drawer's header as a step in the rule
 * that runs across the window, and the content area would jump by a band's
 * height the moment the last tab closed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TabStrip } from "./TabStrip";
import { useTabsStore } from "@/stores";
import { NEW_REQUEST_CHORD } from "@/constants/shortcuts";
import { formatChord } from "@/lib/platform";

vi.mock("@/queries", () => ({
	requestDetailOptions: () => ({
		queryKey: ["request"],
		queryFn: async () => undefined,
		enabled: false,
	}),
	runDetailOptions: () => ({ queryKey: ["run"], queryFn: async () => undefined, enabled: false }),
	useCollectionsQuery: () => ({ data: [] }),
}));
vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({ resolveString: (s: string) => s }),
}));

function renderStrip() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<TabStrip />
		</QueryClientProvider>
	);
}

beforeEach(() => {
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});
afterEach(cleanup);

describe("an empty tab strip", () => {
	it("says how to open something, naming this platform's chord", () => {
		renderStrip();
		// The chord is read from the registry here too: asserting "Ctrl+N" would
		// be a test that passes only on the platform CI happens to run on.
		const hint = screen.getByText(
			`Open a request from the drawer, or press ${formatChord(NEW_REQUEST_CHORD)}`
		);
		expect(hint).toBeInTheDocument();
		expect(hint.className).toContain("text-muted-foreground");
	});

	it("keeps the band and the New-tab button", () => {
		renderStrip();
		const strip = screen.getByRole("tablist").parentElement!;
		expect(strip.className).toContain("h-[var(--tabstrip-height)]");
		expect(screen.getByRole("button", { name: "New tab" })).toBeInTheDocument();
		// And the tablist is still there, empty: the roving-tabindex handler and
		// the aria relationship belong to the element, not to its children.
		expect(screen.getByRole("tablist").children).toHaveLength(0);
	});

	it("says nothing once a tab is open", () => {
		useTabsStore.setState({
			openTabs: [{ id: "t0", type: "settings", entityId: null }],
			activeTabId: "t0",
		});
		renderStrip();
		expect(screen.queryByText(/Open a request from the drawer/)).toBeNull();
		expect(screen.getAllByRole("tab")).toHaveLength(1);
	});
});
