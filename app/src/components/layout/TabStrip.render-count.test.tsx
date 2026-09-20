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
 * changed.
 *
 * `TabItem` (in its own module, `./TabItem`, for exactly this reason) is
 * wrapped here in a second, identically-shallow `memo` whose body counts
 * renders per tab id before delegating to the real `TabItemImpl` - not a
 * `Profiler`, because a `Profiler` around the tab list fires on every commit
 * regardless of which memoized child actually re-executed its render
 * function, which is exactly the distinction this test needs (the same
 * reasoning, and the same shape, as #1716's `KeyValueEditor/index.test.tsx`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { memo, createElement, type ComponentProps } from "react";
import { render, screen, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TabStrip } from "./TabStrip";
import { useTabsStore } from "@/stores";
import type TabItemType from "./TabItem";

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

const renderCounts: Record<string, number> = {};

vi.mock("./TabItem", async (importOriginal) => {
	const mod = await importOriginal<{
		default: typeof TabItemType;
		TabItemImpl: typeof TabItemType;
	}>();
	// Imported dynamically inside the factory, not as a top-level static
	// import: `vi.mock` factories are hoisted above the file's own imports,
	// so a top-level binding referenced here throws "Cannot access ... before
	// initialization". This is the same comparator the real `TabItem` uses,
	// so this counting wrapper bails exactly when the real memo would.
	const { tabItemPropsEqual } = await import("./tab-item-props-equal");
	const Counting = memo((props: ComponentProps<typeof mod.TabItemImpl>) => {
		renderCounts[props.tab.id] = (renderCounts[props.tab.id] ?? 0) + 1;
		return createElement(mod.TabItemImpl, props);
	}, tabItemPropsEqual);
	return { ...mod, default: Counting };
});

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

beforeEach(() => {
	useTabsStore.setState({
		openTabs: [...TABS],
		activeTabId: "t1",
		navHistory: [],
		navIndex: -1,
	});
	for (const tab of TABS) renderCounts[tab.id] = 0;
});
afterEach(cleanup);

describe("TabStrip render count", () => {
	it("re-renders only the two tabs whose active state changed", async () => {
		renderStrip();
		// Every tab mounts once; only the mount matters as a starting point.
		for (const tab of TABS) expect(renderCounts[tab.id]).toBeGreaterThan(0);
		for (const tab of TABS) renderCounts[tab.id] = 0;

		await act(async () => useTabsStore.getState().focusTab("t2"));
		expect(renderCounts.t1).toBeGreaterThan(0);
		expect(renderCounts.t2).toBeGreaterThan(0);
		expect(renderCounts.t3).toBe(0);

		for (const tab of TABS) renderCounts[tab.id] = 0;
		await act(async () => useTabsStore.getState().focusTab("t3"));
		expect(renderCounts.t1).toBe(0);
		expect(renderCounts.t2).toBeGreaterThan(0);
		expect(renderCounts.t3).toBeGreaterThan(0);

		// And the strip itself did draw three tabs throughout - a broken mock
		// that rendered nothing would otherwise pass every assertion above for
		// having counted nothing at all.
		expect(screen.getAllByRole("tab")).toHaveLength(3);
	});
});
