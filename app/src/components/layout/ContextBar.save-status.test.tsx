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
 * A committed variable used to leave "Saved" in the Dock forever.
 *
 * The context bar is the app's one non-draft commit path: it fires the mutation
 * on blur and reported success with a bare `completeSave()` - `saved`, and no
 * reset armed at all. Nothing else was going to clear it, so the Dock kept
 * claiming a save that had happened minutes ago until some unrelated surface
 * published a status of its own. It reports through `completeSaveThenIdle` now,
 * like every other saving surface, which also means it cannot stomp a failure
 * that arrives in the two seconds after.
 *
 * The harness is `ContextBar.save-error.test.tsx`'s.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TIMING } from "@/config/timing";
import { ContextBar } from "./ContextBar";
import { TooltipProvider } from "@/components/ui";
import { queryKeys } from "@/queries/keys";
import { useSaveStore } from "@/stores/save-store";
import { useToastStore } from "@/stores/toast-store";
import type { ResolvedVariable } from "@/types";

const globalsMutate = vi.fn(
	(_payload: unknown, opts: { onSuccess?: () => void; onSettled: () => void }) => {
		opts.onSuccess?.();
		opts.onSettled();
	}
);

vi.mock("@/queries", () => ({
	useRequestQuery: () => ({ data: { id: "req_1", collectionId: null } }),
	useUpdateGlobalsMutation: () => ({ mutate: globalsMutate }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useUpdateCollectionMutation: () => ({ mutate: vi.fn() }),
}));

const resolved: Record<string, ResolvedVariable> = {
	host: { value: "example.com", scope: "global" },
};

vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({ getAllVariables: () => resolved }),
}));

const layoutStore = {
	contextBarOpen: true,
	setContextBarOpen: vi.fn(),
	contextBarWidth: 280,
	setContextBarWidth: vi.fn(),
};
const tabsStore = {
	openTabs: [{ id: "t1", type: "request", entityId: "req_1" }],
	activeTabId: "t1",
};

vi.mock("@/stores", async () => {
	const saveStore =
		await vi.importActual<typeof import("@/stores/save-store")>("@/stores/save-store");
	return {
		useLayoutStore: () => layoutStore,
		useTabsStore: () => tabsStore,
		useSaveStore: saveStore.useSaveStore,
	};
});

function renderBar() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(queryKeys.globals.all, {
		id: "globals",
		updatedAt: "",
		variables: {
			host: { value: "example.com", enabled: true, secret: false, type: "string" },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<ContextBar />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

/** Commit an edit to the one variable on screen. */
function commitOnce() {
	renderBar();
	const input = screen.getByDisplayValue("example.com") as HTMLInputElement;
	act(() => {
		fireEvent.change(input, { target: { value: "example.org" } });
		fireEvent.blur(input);
	});
	expect(globalsMutate).toHaveBeenCalledTimes(1);
	expect(useSaveStore.getState().status).toBe("saved");
}

describe("the status a context-bar commit publishes", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		globalsMutate.mockClear();
		useSaveStore.setState({ status: "idle", contexts: new Map(), activeContextId: null });
		useToastStore.setState({ toasts: [] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns the Dock to idle instead of leaving 'Saved' up indefinitely", async () => {
		commitOnce();

		await act(async () => {
			vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS);
		});

		expect(useSaveStore.getState().status).toBe("idle");
	});

	it("leaves a failure that arrived meanwhile on screen", async () => {
		commitOnce();

		act(() => useSaveStore.getState().failSave("delete failed"));
		await act(async () => {
			vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS);
		});

		expect(useSaveStore.getState().status).toBe("error");
	});
});
