/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMcpDataInvalidation } from "./useMcpDataInvalidation";
import { queryKeys } from "@/queries/keys";
import type { McpDataChangedEvent } from "@/types/domain";

type ChangedCb = (event: McpDataChangedEvent) => void;

let changedCb: ChangedCb | null;
let unsubscribed: boolean;

beforeEach(() => {
	changedCb = null;
	unsubscribed = false;
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		onMcpDataChanged: (cb: ChangedCb) => {
			changedCb = cb;
			return () => {
				unsubscribed = true;
				changedCb = null;
			};
		},
	};
});

afterEach(() => {
	delete (window as unknown as { electronAPI?: unknown }).electronAPI;
	vi.restoreAllMocks();
});

function setup() {
	const queryClient = new QueryClient();
	const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	const view = renderHook(() => useMcpDataInvalidation(), { wrapper });
	return { view, spy };
}

describe("useMcpDataInvalidation", () => {
	test("an event from the main process reaches the query cache", () => {
		const { spy } = setup();
		expect(changedCb).not.toBeNull();

		act(() => changedCb!({ entity: "request", collectionId: "col_1" }));

		expect(spy).toHaveBeenCalledWith({
			queryKey: queryKeys.requests.listByCollection("col_1"),
		});
	});

	test("it unsubscribes on unmount", () => {
		const { view } = setup();
		view.unmount();
		expect(unsubscribed).toBe(true);
	});

	test("it is inert outside Electron", () => {
		// A browser dev server has no `electronAPI`, and no MCP server to hear
		// from - registering must not throw there.
		delete (window as unknown as { electronAPI?: unknown }).electronAPI;
		expect(() => setup()).not.toThrow();
	});
});
