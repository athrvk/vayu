/**
 * @vitest-environment jsdom
 */

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSessionStore, useTabsStore, type Tab } from "@/stores";
import { focusTabLabel, useAppFocusMirror } from "./useAppFocusMirror";

const listEnvironments = vi.fn();
vi.mock("@/services/api", () => ({
	apiService: { listEnvironments: (...a: unknown[]) => listEnvironments(...a) },
}));

/** The label each tab resolves to, set per test; the real hook needs a query client full of requests. */
const descriptors = new Map<string, { label: string; isPath?: boolean; fromUrl?: boolean }>();
vi.mock("@/components/layout/tab-descriptors", () => ({
	useTabDescriptors: (tabs: Tab[]) =>
		tabs.map((tab) => descriptors.get(tab.id) ?? { label: tab.type }),
}));

const REQUEST_TAB: Tab = { id: "t1", type: "request", entityId: "req_1" };
const RUN_TAB: Tab = { id: "t2", type: "run", entityId: "run_1" };
const ENVIRONMENTS = [
	{ id: "env_dev", name: "Dev" },
	{ id: "env_prod", name: "Prod" },
];

function wrapper() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	});
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

describe("useAppFocusMirror", () => {
	let publish: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		descriptors.clear();
		descriptors.set("t1", { label: "Create order" });
		descriptors.set("t2", { label: "Design run" });
		listEnvironments.mockResolvedValue(ENVIRONMENTS);
		useTabsStore.setState({ openTabs: [REQUEST_TAB, RUN_TAB], activeTabId: "t1" });
		useSessionStore.setState({ activeEnvironmentId: "env_dev" });
		publish = vi.fn();
		vi.stubGlobal("electronAPI", { publishAppFocus: publish });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("publishes the active tab and the named environment", async () => {
		renderHook(() => useAppFocusMirror(), { wrapper: wrapper() });
		await waitFor(() =>
			expect(publish).toHaveBeenLastCalledWith({
				activeTab: { type: "request", entityId: "req_1", label: "Create order" },
				activeEnvironment: { id: "env_dev", name: "Dev" },
			})
		);
	});

	it("publishes again when another tab is activated", async () => {
		renderHook(() => useAppFocusMirror(), { wrapper: wrapper() });
		await waitFor(() => expect(publish).toHaveBeenCalledTimes(2));

		act(() => useTabsStore.setState({ activeTabId: "t2" }));
		expect(publish).toHaveBeenLastCalledWith({
			activeTab: { type: "run", entityId: "run_1", label: "Design run" },
			activeEnvironment: { id: "env_dev", name: "Dev" },
		});
	});

	it("publishes again when the environment changes, and null when none is active", async () => {
		renderHook(() => useAppFocusMirror(), { wrapper: wrapper() });
		await waitFor(() => expect(publish).toHaveBeenCalledTimes(2));

		// Mutation check: stop reading `activeEnvironmentId` and this stays at 2.
		act(() => useSessionStore.setState({ activeEnvironmentId: "env_prod" }));
		expect(publish).toHaveBeenLastCalledWith(
			expect.objectContaining({ activeEnvironment: { id: "env_prod", name: "Prod" } })
		);

		act(() => useSessionStore.setState({ activeEnvironmentId: null }));
		expect(publish).toHaveBeenLastCalledWith(
			expect.objectContaining({ activeEnvironment: null })
		);
	});

	it("publishes null for the tab when none is open", async () => {
		useTabsStore.setState({ openTabs: [], activeTabId: null });
		renderHook(() => useAppFocusMirror(), { wrapper: wrapper() });
		await waitFor(() =>
			expect(publish).toHaveBeenLastCalledWith({
				activeTab: null,
				activeEnvironment: { id: "env_dev", name: "Dev" },
			})
		);
	});

	it("does not resend a snapshot that did not change", async () => {
		const view = renderHook(() => useAppFocusMirror(), { wrapper: wrapper() });
		await waitFor(() => expect(publish).toHaveBeenCalledTimes(2));

		// Mutation check: drop the serialized comparison and every render resends.
		view.rerender();
		act(() => useTabsStore.setState({ openTabs: [{ ...REQUEST_TAB }, RUN_TAB] }));
		act(() => useSessionStore.setState({ lastCollectionId: "col_1" }));
		expect(publish).toHaveBeenCalledTimes(2);
	});

	it("does nothing outside Electron", async () => {
		vi.stubGlobal("electronAPI", undefined);
		const view = renderHook(() => useAppFocusMirror(), { wrapper: wrapper() });
		await waitFor(() => expect(listEnvironments).toHaveBeenCalled());
		expect(() => act(() => useTabsStore.setState({ activeTabId: "t2" }))).not.toThrow();
		view.unmount();
		expect(publish).not.toHaveBeenCalled();
	});

	it("never publishes URL-derived text, which carries resolved variable values", async () => {
		descriptors.set("t1", { label: "/orders/s3cret-token", isPath: true, fromUrl: true });
		renderHook(() => useAppFocusMirror(), { wrapper: wrapper() });
		await waitFor(() => expect(publish).toHaveBeenCalled());
		// Mutation check: return `descriptor.label` unconditionally and this fails.
		for (const [snapshot] of publish.mock.calls) {
			expect(JSON.stringify(snapshot)).not.toContain("s3cret-token");
		}
		expect(publish).toHaveBeenLastCalledWith(
			expect.objectContaining({
				activeTab: { type: "request", entityId: "req_1", label: "Request" },
			})
		);
	});
});

describe("focusTabLabel", () => {
	it.each([
		["a saved name", REQUEST_TAB, { label: "Create order" }, "Create order"],
		[
			"a request labelled by its URL",
			REQUEST_TAB,
			{ label: "/a/b", isPath: true, fromUrl: true },
			"Request",
		],
		[
			"a run labelled by its URL",
			RUN_TAB,
			{ label: "/a/b", isPath: true, fromUrl: true },
			"Run",
		],
		[
			"a run labelled by its kind",
			RUN_TAB,
			{ label: "Load test", fromUrl: false },
			"Load test",
		],
	])("%s", (_name, tab, descriptor, expected) => {
		expect(focusTabLabel(tab, descriptor)).toBe(expected);
	});
});
