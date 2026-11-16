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
 * Opening a run from the list opens its tab, and tells the drawer so an
 * overlay can leave (#3507).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { DrawerItemOpenedProvider } from "@/components/layout/drawer-item-opened";
import { apiService } from "@/services/api";
import { useHistoryStore } from "@/modules/history/history-store";
import { useTabsStore } from "@/stores";
import type { Run, RunListResponse } from "@/types";
import HistoryList from "./HistoryList";

vi.mock("@/queries", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/queries")>();
	return { ...actual, useCollectionsQuery: () => ({ data: [] }) };
});

const onItemOpened = vi.fn();

beforeEach(() => {
	onItemOpened.mockClear();
	const runs = [
		{
			id: "r1",
			type: "load",
			status: "completed",
			startTime: Date.now(),
			requestId: "req_r1",
			environmentId: null,
			summary: { url: "http://r1.test/" },
		} as Run,
	];
	const envelope: RunListResponse = {
		data: runs,
		pagination: {
			total: 1,
			limit: 50,
			offset: 0,
			hasMore: false,
			returned: 1,
			nextBefore: null,
		},
	};
	vi.spyOn(apiService, "listRuns").mockResolvedValue(envelope);
	useHistoryStore.getState().resetFilters();
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the history list's selection", () => {
	it("tells the drawer after opening a run's tab", async () => {
		render(
			<QueryClientProvider
				client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
			>
				<TooltipProvider>
					<DrawerItemOpenedProvider value={onItemOpened}>
						<HistoryList />
					</DrawerItemOpenedProvider>
				</TooltipProvider>
			</QueryClientProvider>
		);
		fireEvent.click(await screen.findByRole("button", { name: /Open Load test, completed/ }));

		expect(useTabsStore.getState().openTabs.map((t) => t.entityId)).toEqual(["r1"]);
		expect(onItemOpened).toHaveBeenCalledTimes(1);
	});
});
