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
 * "No mock running" says where a mock comes from, and now goes there
 * (issue #1693).
 *
 * A mock is started from a collection's header, so this pane has no create
 * handler of its own to offer - and an action that opens the surface that
 * does is the honest version of the sentence the pane already wrote.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import MockServerView from "./index";
import {
	useMockActivityQuery,
	useMockServerRoutesQuery,
	useMockServersQuery,
	useStopMockServerMutation,
} from "@/queries";
import { useLayoutStore, useTabsStore } from "@/stores";

vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useMockServersQuery: vi.fn(),
	useMockServerRoutesQuery: vi.fn(),
	useMockActivityQuery: vi.fn(),
	useStopMockServerMutation: vi.fn(),
}));

beforeEach(() => {
	cleanup();
	vi.mocked(useMockServersQuery).mockReturnValue({
		data: [],
		isError: false,
	} as unknown as ReturnType<typeof useMockServersQuery>);
	vi.mocked(useMockServerRoutesQuery).mockReturnValue({
		data: [],
	} as unknown as ReturnType<typeof useMockServerRoutesQuery>);
	vi.mocked(useMockActivityQuery).mockReturnValue({
		data: [],
	} as unknown as ReturnType<typeof useMockActivityQuery>);
	vi.mocked(useStopMockServerMutation).mockReturnValue({
		mutateAsync: vi.fn(),
		isPending: false,
	} as unknown as ReturnType<typeof useStopMockServerMutation>);
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useLayoutStore.setState({ drawerView: "history", drawerOpen: false });
});

describe("the mock server view with nothing running", () => {
	it("offers the collections drawer, where a mock is started", () => {
		render(<MockServerView />);
		expect(screen.getByText("No mock running")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Browse collections" }));
		expect(useLayoutStore.getState().drawerView).toBe("collections");
		expect(useLayoutStore.getState().drawerOpen).toBe(true);
	});
});
