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
 * With three open tabs, a `focusTab` must re-render only the two tabs whose
 * `isActive` actually changed - not the third (#1714).
 *
 * Before the fix, `TabItem` called `useTabsStore()` with no selector, so it
 * re-rendered on every write to the tabs store regardless of which field
 * changed. Read via `data-render-count` (a ref bumped once per actual call
 * to the render function, in `TabStrip.tsx`) rather than a `Profiler`:
 * `Profiler.onRender` fires for a memoized child's `Profiler` wrapper on
 * every commit whether or not that child's render function actually ran, so
 * it cannot tell a bailout from a real re-render the way this counter does.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TabStrip } from "./TabStrip";
import { useTabsStore } from "@/stores";

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

const TABS = [
	{ id: "t1", type: "welcome" as const, entityId: null },
	{ id: "t2", type: "settings" as const, entityId: null },
	{ id: "t3", type: "variables" as const, entityId: null },
];

function renderCounts(): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const tab of screen.getAllByRole("tab")) {
		const id = tab.getAttribute("data-tab-id")!;
		counts[id] = Number(tab.getAttribute("data-render-count"));
	}
	return counts;
}

beforeEach(() => {
	useTabsStore.setState({
		openTabs: [...TABS],
		activeTabId: "t1",
		navHistory: [],
		navIndex: -1,
	});
});
afterEach(cleanup);

describe("TabStrip render count", () => {
	it("re-renders only the two tabs whose active state changed", async () => {
		renderStrip();
		const afterMount = renderCounts();

		await act(async () => useTabsStore.getState().focusTab("t2"));
		const afterFirstFocus = renderCounts();
		expect(afterFirstFocus.t1).toBe(afterMount.t1 + 1);
		expect(afterFirstFocus.t2).toBe(afterMount.t2 + 1);
		expect(afterFirstFocus.t3).toBe(afterMount.t3);

		await act(async () => useTabsStore.getState().focusTab("t3"));
		const afterSecondFocus = renderCounts();
		expect(afterSecondFocus.t1).toBe(afterFirstFocus.t1);
		expect(afterSecondFocus.t2).toBe(afterFirstFocus.t2 + 1);
		expect(afterSecondFocus.t3).toBe(afterFirstFocus.t3 + 1);
	});
});
