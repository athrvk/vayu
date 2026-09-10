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
 * The request builder's active sub-tab, kept per request id in
 * `tab-selection-store`.
 *
 * `Shell.tsx` mounts one workspace-tab's surface at a time, so switching away
 * from a request tab and back used to reset `RequestTabs` to Params every
 * time - `activeTab` was a bare `useState` with no memory of which request it
 * belonged to. The reset block that already restores the response and the
 * request state per `initialRequest.id` change (issue #1436's per-field
 * merge lives right beside it) is where the tab restoration was added, since
 * switching between two open request tabs reuses this same provider instance
 * rather than remounting it.
 *
 * Mocked down to the same seams `RequestBuilderProvider.name-sync.test.tsx`
 * uses: none of variable resolution, the save manager or the query hooks has
 * anything to do with which tab is selected.
 *
 * Mutation check: drop the `setActiveTabState` restore call from the reset
 * block, or drop `setRequestTab` from the wrapped `setActiveTab`, and the
 * "survives" case below fails red; restoring either makes it green again.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
import { useTabSelectionStore } from "@/stores/tab-selection-store";
import type { RequestState } from "../types";

vi.mock("@/hooks", () => ({
	useVariableResolver: () => ({
		resolveString: (s: string) => s,
		resolveObject: (o: unknown) => o,
		getVariable: () => null,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
	}),
	useVariableWriter: () => ({ updateVariable: vi.fn(), writableScopes: [] }),
	useSaveManager: () => ({ forceSave: vi.fn(), status: "idle", isSaving: false }),
}));

vi.mock("@/queries", () => ({
	useElementKindsQuery: () => ({ data: [] }),
	useGlobalsQuery: () => ({ data: { variables: {} } }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn() }),
	useCollectionsQuery: () => ({ data: [] }),
	useCollectionAncestors: () => [],
	useUpdateCollectionMutation: () => ({ mutate: vi.fn() }),
	useEnvironmentsQuery: () => ({ data: [] }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useLastDesignRunQuery: () => ({ run: undefined, report: undefined, isLoading: false }),
	useConfigQuery: () => ({ data: { entries: [] } }),
}));

/** Shows which sub-tab is active, and offers a way to change it. */
function TabProbe() {
	const { activeTab, setActiveTab } = useRequestBuilderContext();
	return (
		<>
			<span data-testid="active-tab">{activeTab}</span>
			<button onClick={() => setActiveTab("headers")}>go to headers</button>
		</>
	);
}

function Harness({ id }: { id: string }) {
	const initialRequest: Partial<RequestState> = { id };
	return (
		<RequestBuilderProvider initialRequest={initialRequest} collectionId="col_1">
			<TabProbe />
		</RequestBuilderProvider>
	);
}

const shownTab = () => screen.getByTestId("active-tab").textContent;
const goToHeaders = () => act(() => screen.getByText("go to headers").click());

beforeEach(() => {
	useTabSelectionStore.getState().clearAll();
});

describe("the active request-builder tab, kept per request id", () => {
	it("defaults to Params for a request seen for the first time", () => {
		render(<Harness id="req_a" />);
		expect(shownTab()).toBe("params");
	});

	it("survives Shell unmounting and remounting the builder for the same request", () => {
		const { unmount } = render(<Harness id="req_a" />);
		goToHeaders();
		expect(shownTab()).toBe("headers");

		unmount();

		// A different request, mounted fresh - shows its own default, not A's.
		const { unmount: unmountB } = render(<Harness id="req_b" />);
		expect(shownTab()).toBe("params");
		unmountB();

		// Back to A - its own selection is still there.
		render(<Harness id="req_a" />);
		expect(shownTab()).toBe("headers");
	});

	it("also keeps each request's tab separate when moving between two open request tabs without a remount", () => {
		// `Shell.tsx` reuses this provider instance across request tabs of the
		// same type, so `initialRequest.id` changes under the same component -
		// exactly what the render-time reset block (not just the mount
		// initializer) has to answer for.
		const { rerender } = render(<Harness id="req_a" />);
		goToHeaders();
		expect(shownTab()).toBe("headers");

		rerender(<Harness id="req_b" />);
		expect(shownTab()).toBe("params");

		rerender(<Harness id="req_a" />);
		expect(shownTab()).toBe("headers");
	});
});
