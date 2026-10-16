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
 * The run-comparison request (#2164). Its own file because it asserts on the
 * store's `persist` options, which only exist where there is a storage - the
 * rest of the tabs-store cases run in the node environment.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { useTabsStore } from "./tabs-store";

beforeEach(() => {
	useTabsStore.setState({ openTabs: [], activeTabId: null, navHistory: [], navIndex: -1 });
});

describe("openRunComparison", () => {
	beforeEach(() => {
		useTabsStore.setState({ compareRunTarget: null });
	});

	it("opens the run's tab and hands its report the request for the comparison", () => {
		useTabsStore.getState().openRunComparison("run_a");

		const { openTabs, activeTabId, compareRunTarget } = useTabsStore.getState();
		expect(openTabs).toHaveLength(1);
		expect(openTabs[0]).toMatchObject({ type: "run", entityId: "run_a" });
		expect(activeTabId).toBe(openTabs[0].id);
		expect(compareRunTarget).toBe("run_a");
	});

	it("focuses a run tab that is already open, still carrying the request", () => {
		useTabsStore.getState().openTab({ type: "run", entityId: "run_a" });
		useTabsStore.getState().openTab({ type: "run", entityId: "run_b" });

		useTabsStore.getState().openRunComparison("run_a");

		const { openTabs, activeTabId, compareRunTarget } = useTabsStore.getState();
		expect(openTabs).toHaveLength(2);
		expect(openTabs.find((t) => t.id === activeTabId)?.entityId).toBe("run_a");
		expect(compareRunTarget).toBe("run_a");
	});

	it("is consumed once, so a later visit opens on the report", () => {
		useTabsStore.getState().openRunComparison("run_a");
		useTabsStore.getState().clearCompareRunTarget();

		expect(useTabsStore.getState().compareRunTarget).toBeNull();
	});

	it("is session-scoped: a request in flight is not written to storage", () => {
		useTabsStore.getState().openRunComparison("run_a");

		const persisted = useTabsStore.persist.getOptions().partialize?.(useTabsStore.getState());

		expect(Object.keys(persisted as object).sort()).toEqual(["activeTabId", "openTabs"]);
	});
});
