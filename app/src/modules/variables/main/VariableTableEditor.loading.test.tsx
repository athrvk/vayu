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
 * The globals editor's first load is a skeleton, not a hand-drawn ring (#2073).
 *
 * `VariablesMain.loading.test.tsx` covers the collection and environment panes
 * it resolves itself; the globals pane is loaded by the editor, so its loading
 * branch is only reachable from here.
 *
 * Mutation-check: restore the bordered spinner `div` in the editor's
 * `isDataLoading` branch and the status-role case fails.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { TooltipProvider } from "@/components/ui";
import VariableTableEditor from "./VariableTableEditor";

vi.mock("@/queries", () => ({
	useGlobalsQuery: () => ({ data: undefined, isLoading: false, error: null }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useSetActiveEnvironmentMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteEnvironmentMutation: () => ({
		mutate: vi.fn(),
		mutateAsync: vi.fn(),
		isPending: false,
	}),
	useUpdateCollectionMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));

const sessionStore = { activeEnvironmentId: null, setActiveEnvironmentId: vi.fn() };

vi.mock("@/stores", async () => {
	const saveStore =
		await vi.importActual<typeof import("@/stores/save-store")>("@/stores/save-store");
	// `VariableRow`'s "Copy for agent" button reads the toast store through `useCopy`.
	const toastStore =
		await vi.importActual<typeof import("@/stores/toast-store")>("@/stores/toast-store");
	return {
		useSaveStore: saveStore.useSaveStore,
		useToastStore: toastStore.useToastStore,
		useSessionStore: Object.assign(() => sessionStore, { getState: () => sessionStore }),
	};
});

vi.mock("@/modules/variables/variables-store", () => ({
	useVariablesStore: () => ({ selectedCategory: null, setSelectedCategory: vi.fn() }),
}));

function renderGlobals(isLoading: boolean) {
	return render(
		<TooltipProvider>
			<VariableTableEditor
				config={{ type: "globals", globalsData: { variables: {} }, isLoading }}
			/>
		</TooltipProvider>
	);
}

describe("VariableTableEditor - globals loading", () => {
	it("holds the pane behind a named skeleton while the globals load", () => {
		const { container } = renderGlobals(true);

		expect(screen.getByRole("status", { name: "Loading variables" })).toBeInTheDocument();
		expect(screen.queryByText("Global variables")).not.toBeInTheDocument();
		expect(container.querySelector(".animate-spin")).toBeNull();
	});

	it("renders the editor, and no skeleton, once they have loaded", () => {
		renderGlobals(false);

		expect(screen.getByText("Global variables")).toBeInTheDocument();
		expect(screen.queryByRole("status", { name: "Loading variables" })).not.toBeInTheDocument();
	});
});
