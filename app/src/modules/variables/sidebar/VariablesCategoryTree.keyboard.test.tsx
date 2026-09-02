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
 * The variables sidebar's keyboard path (#1217).
 *
 * Rename and Duplicate exist nowhere but this tree's ⋯ menu, whose trigger is
 * `tabIndex={-1}` and opens on a pointer - so with no key handler on the rows,
 * both actions were unreachable without a mouse. The rest was cost rather than
 * blockage: one Tab stop per control, in a drawer whose sibling views are one
 * stop each.
 *
 * These cases pin the tree contract on the real component - the rows carry the
 * `data-tree-*` attributes `useRovingTreeFocus` clicks, so removing any one of
 * them (or the `role="treeitem"` that makes the hook look at the row at all)
 * takes its key down with it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import VariablesCategoryTree from "./VariablesCategoryTree";
import type { Collection, Environment } from "@/types";

const STAGING: Environment = {
	id: "env_1",
	name: "Staging",
	description: "",
	variables: {},
	isActive: false,
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
};

const PRODUCTION: Environment = { ...STAGING, id: "env_2", name: "Production" };

const COLLECTION: Collection = {
	id: "col_1",
	name: "Acme API",
	description: "",
	order: 0,
	variables: {},
	auth: { mode: "none" },
	preRequestScript: "",
	postRequestScript: "",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
};

const idle = { isLoading: false, isError: false, refetch: vi.fn() };
const createEnvironment = vi.fn();
const updateEnvironment = vi.fn();

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({ ...idle, data: [COLLECTION] }),
	useEnvironmentsQuery: () => ({ ...idle, data: [STAGING, PRODUCTION] }),
	useCreateEnvironmentMutation: () => ({ mutateAsync: createEnvironment, isPending: false }),
	useDeleteEnvironmentMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateEnvironmentMutation: () => ({ mutateAsync: updateEnvironment, isPending: false }),
}));

const setSelectedCategory = vi.fn();
vi.mock("@/stores", () => ({ useTabsStore: () => ({ openTab: vi.fn() }) }));
vi.mock("@/modules/variables/variables-store", () => ({
	useVariablesStore: () => ({ selectedCategory: null, setSelectedCategory }),
}));

function renderTree() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<VariablesCategoryTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
	return screen.getByRole("tree", { name: "Variable scopes" });
}

/** The row whose `data-tree-label` is `name` - the name the user sees. */
function row(tree: HTMLElement, name: string): HTMLElement {
	const found = within(tree)
		.getAllByRole("treeitem")
		.find((item) => item.getAttribute("data-tree-label") === name);
	if (!found) throw new Error(`no row labelled "${name}"`);
	return found;
}

/** Focus a row the way an arrow key would, then press a key on it. */
function press(target: HTMLElement, key: string, init: Partial<KeyboardEventInit> = {}) {
	target.focus();
	fireEvent.keyDown(target, { key, ...init });
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("the sidebar is one tree, not a list of tab stops", () => {
	it("gives every scope a row and exactly one of them the tab stop", () => {
		const tree = renderTree();
		const rows = within(tree).getAllByRole("treeitem");

		// Globals, Environments, its two, Collections, its one - in the order
		// they are seen, which is the order the arrows walk.
		expect(rows.map((r) => r.getAttribute("data-tree-label"))).toEqual([
			"Globals",
			"Environments",
			"Staging",
			"Production",
			"Collections",
			"Acme API",
		]);
		expect(rows.filter((r) => r.tabIndex === 0)).toHaveLength(1);
	});

	it("leaves the row's own controls out of the tab order", () => {
		const tree = renderTree();

		// Every control inside a row is -1: the keys below are the only path to
		// them, which is what makes the tree a single stop.
		const inRowControls = within(tree)
			.getAllByRole("treeitem")
			.flatMap((item) => Array.from(item.querySelectorAll("button")));
		expect(inRowControls.length).toBeGreaterThan(0);
		expect(inRowControls.every((button) => button.tabIndex === -1)).toBe(true);

		// "Add environment" is the one deliberate exception, and it sits outside
		// the header's row: the tree owns no "create" key, so taking this button
		// out of the tab order would make creating an environment mouse-only -
		// the defect this file just fixed, pointing the other way.
		const stops = Array.from(tree.querySelectorAll<HTMLElement>("button")).filter(
			(button) => button.tabIndex !== -1
		);
		expect(stops.map((button) => button.getAttribute("aria-label"))).toEqual([
			"Add environment",
		]);
	});

	it("states the hierarchy rather than leaving it to be inferred", () => {
		const tree = renderTree();

		expect(row(tree, "Environments").getAttribute("aria-level")).toBe("1");
		expect(row(tree, "Environments").getAttribute("aria-expanded")).toBe("true");
		expect(row(tree, "Staging").getAttribute("aria-level")).toBe("2");
		expect(row(tree, "Staging").getAttribute("aria-posinset")).toBe("1");
		expect(row(tree, "Staging").getAttribute("aria-setsize")).toBe("2");

		// The list is a sibling of its header in the DOM, so the header has to
		// claim it - otherwise the two read as unrelated flat runs of rows.
		const owned = row(tree, "Environments").getAttribute("aria-owns");
		expect(owned).toBeTruthy();
		expect(document.getElementById(owned as string)).toContainElement(row(tree, "Staging"));
	});
});

describe("moving around it", () => {
	it("moves focus with the arrows instead of Tab", () => {
		const tree = renderTree();

		press(row(tree, "Globals"), "ArrowDown");
		expect(document.activeElement).toBe(row(tree, "Environments"));

		press(row(tree, "Environments"), "ArrowDown");
		expect(document.activeElement).toBe(row(tree, "Staging"));
	});

	it("jumps to a row by typing its name", () => {
		const tree = renderTree();

		press(row(tree, "Globals"), "p");

		// "Production", not the "Collections" row it sits below: typeahead reads
		// `data-tree-label`, the name the user sees.
		expect(document.activeElement).toBe(row(tree, "Production"));
	});

	it("collapses and expands a section with Left and Right", () => {
		const tree = renderTree();

		press(row(tree, "Environments"), "ArrowLeft");
		expect(row(tree, "Environments").getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("Staging")).not.toBeInTheDocument();

		press(row(tree, "Environments"), "ArrowRight");
		expect(row(tree, "Environments").getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText("Staging")).toBeInTheDocument();
	});
});

describe("the actions that had no keyboard path", () => {
	it.each([
		["Shift+F10", { key: "F10", shiftKey: true }],
		["the Menu key", { key: "ContextMenu" }],
		["Shift+Enter", { key: "Enter", shiftKey: true }],
	])("opens the row menu with %s", async (_label, event) => {
		const tree = renderTree();

		press(row(tree, "Staging"), event.key, event);

		const menu = await screen.findByRole("menu");
		expect(within(menu).getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
		expect(within(menu).getByRole("menuitem", { name: "Duplicate" })).toBeInTheDocument();
	});

	it("duplicates the row the menu was opened from", async () => {
		const tree = renderTree();
		press(row(tree, "Staging"), "F10", { shiftKey: true });

		fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));

		await waitFor(() => expect(createEnvironment).toHaveBeenCalledTimes(1));
		expect(createEnvironment.mock.calls[0][0]).toMatchObject({ name: "Staging (Copy)" });
	});

	it("renames on F2 and hands focus back to the row on Escape", () => {
		const tree = renderTree();

		press(row(tree, "Staging"), "F2");
		const field = screen.getByDisplayValue("Staging");

		fireEvent.keyDown(field, { key: "Escape" });

		// The tree is one tab stop; a rename that ended on <body> would drop the
		// user out of it entirely.
		expect(screen.queryByDisplayValue("Staging")).not.toBeInTheDocument();
		expect(document.activeElement).toBe(row(tree, "Staging"));
	});

	it("asks before deleting on Delete and on Backspace", () => {
		const tree = renderTree();

		press(row(tree, "Production"), "Delete");
		expect(screen.getByText(/"Production" will be permanently removed/)).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		// The key a Mac keyboard actually has. Both are live on every platform,
		// so neither is asserted against a stubbed `isMac`.
		press(row(tree, "Staging"), "Backspace");
		expect(screen.getByText(/"Staging" will be permanently removed/)).toBeInTheDocument();
	});
});
