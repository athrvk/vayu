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
 * Deleting an environment moves it to the Trash (#2970), from either of the two
 * places that offer it: the editor header's delete button and the sidebar row.
 *
 * Both say so before the delete (the dialog no longer claims it cannot be
 * undone) and after it (the same "Moved to the Trash" toast with Undo the
 * collection tree raises). The Undo restores the row and nothing else: the
 * engine returns a restored environment inactive, and the app must not make it
 * active again behind the user's back.
 *
 * Mutation checks: drop the `offerUndo` call from either handler and its
 * "offers it back" case fails; put "This can't be undone." back into
 * `environmentDeleteDescription` and both dialog cases fail.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TooltipProvider } from "@/components/ui";
import { useSessionStore } from "@/stores";
import { useVariablesStore } from "@/modules/variables/variables-store";
import type { Environment } from "@/types";
import VariableTableEditor from "./main/VariableTableEditor";
import VariablesCategoryTree from "./sidebar/VariablesCategoryTree";

const STAGING: Environment = {
	id: "env_1",
	name: "Staging",
	description: "",
	isActive: false,
	variables: { baseUrl: { value: "https://staging.test", enabled: true } },
	createdAt: new Date(0).toISOString(),
	updatedAt: new Date(0).toISOString(),
};

const deleteEnvironment = vi.fn();
const restoreTrash = vi.fn();
const setActiveEnvironment = vi.fn();
const showToast = vi.fn();

vi.mock("@/queries", () => {
	const idle = { isLoading: false, isError: false, error: null, refetch: vi.fn() };
	const noop = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
	return {
		useCollectionsQuery: () => ({ ...idle, data: [] }),
		useEnvironmentsQuery: () => ({ ...idle, data: [STAGING] }),
		useGlobalsQuery: () => ({ ...idle, data: undefined }),
		useUpdateGlobalsMutation: noop,
		useCreateEnvironmentMutation: noop,
		useUpdateEnvironmentMutation: noop,
		useUpdateCollectionMutation: noop,
		useSetActiveEnvironmentMutation: () => ({
			mutate: setActiveEnvironment,
			mutateAsync: setActiveEnvironment,
			isPending: false,
		}),
		useDeleteEnvironmentMutation: () => ({
			mutate: vi.fn(),
			mutateAsync: deleteEnvironment,
			isPending: false,
		}),
		useRestoreTrashMutation: () => ({ mutateAsync: restoreTrash, isPending: false }),
	};
});

// Only the toast store is replaced, so the toast's options object can be read
// back; the session, save, tab and layout stores the two views drive stay real.
vi.mock("@/stores", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/stores")>();
	return {
		...actual,
		useToastStore: Object.assign(
			(selector: (s: { showToast: typeof showToast }) => unknown) => selector({ showToast }),
			{ getState: () => ({ showToast }) }
		),
	};
});

function withProviders(ui: React.ReactElement) {
	return render(
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
		>
			<TooltipProvider>{ui}</TooltipProvider>
		</QueryClientProvider>
	);
}

/** The options object handed to the last `showToast` call. */
function lastToast() {
	const calls = showToast.mock.calls;
	return calls[calls.length - 1]?.[0];
}

/** Open the header's delete dialog and return it. */
async function openHeaderDialog() {
	withProviders(<VariableTableEditor config={{ type: "environment", environment: STAGING }} />);
	fireEvent.click(screen.getByRole("button", { name: "Delete environment" }));
	return screen.findByRole("dialog");
}

/** Open the sidebar row's delete dialog (the tree's Delete key) and return it. */
async function openSidebarDialog() {
	withProviders(<VariablesCategoryTree />);
	const row = within(screen.getByRole("tree", { name: "Variable scopes" }))
		.getAllByRole("treeitem")
		.find((item) => item.getAttribute("data-tree-label") === "Staging");
	if (!row) throw new Error("no Staging row");
	row.focus();
	fireEvent.keyDown(row, { key: "Delete" });
	return screen.findByRole("dialog");
}

const CALL_SITES = [
	["the editor header", openHeaderDialog],
	["the sidebar row", openSidebarDialog],
] as const;

beforeEach(() => {
	deleteEnvironment.mockReset().mockResolvedValue(undefined);
	restoreTrash.mockReset().mockResolvedValue({
		id: "env_1",
		kind: "environment",
		name: "Staging",
		deletedAt: 1,
		collections: 0,
		requests: 0,
		variables: 1,
		restored: true,
		reparentedToRoot: false,
	});
	setActiveEnvironment.mockReset();
	showToast.mockReset();
	// What the delete mutation leaves behind for an environment that was active.
	useSessionStore.setState({ activeEnvironmentId: null });
	useVariablesStore.setState({
		selectedCategory: { type: "environment", environmentId: "env_1" },
	});
});

describe.each(CALL_SITES)("deleting an environment from %s", (_where, openDialog) => {
	it("says the Trash can give it back, not that it can't be undone", async () => {
		const dialog = await openDialog();

		expect(dialog).toHaveTextContent("Its 1 variable goes with it.");
		expect(dialog).toHaveTextContent("You can restore it from Trash.");
		expect(dialog.textContent).not.toMatch(/can't be undone|cannot be undone/);
	});

	it("says where it went, and offers it back without re-activating it", async () => {
		const dialog = await openDialog();
		fireEvent.click(within(dialog).getByRole("button", { name: "Delete environment" }));

		await waitFor(() => expect(deleteEnvironment).toHaveBeenCalledWith("env_1"));
		await waitFor(() =>
			expect(lastToast()).toMatchObject({
				message: 'Moved "Staging" to the Trash',
				variant: "info",
				action: { label: "Undo", altText: "Undo deleting the environment Staging" },
			})
		);
		expect(useVariablesStore.getState().selectedCategory).toBeNull();

		lastToast().action.onClick();

		await waitFor(() => expect(restoreTrash).toHaveBeenCalledWith("env_1"));
		// The engine restores it inactive; nothing here switches to it.
		expect(setActiveEnvironment).not.toHaveBeenCalled();
		expect(useSessionStore.getState().activeEnvironmentId).toBeNull();
	});

	it("reports a failed delete and offers no undo", async () => {
		deleteEnvironment.mockRejectedValue(new Error("database is locked"));
		const dialog = await openDialog();
		fireEvent.click(within(dialog).getByRole("button", { name: "Delete environment" }));

		await waitFor(() =>
			expect(showToast).toHaveBeenCalledWith(
				"Couldn't delete the environment - database is locked",
				"error"
			)
		);
		expect(showToast).toHaveBeenCalledTimes(1);
	});
});
