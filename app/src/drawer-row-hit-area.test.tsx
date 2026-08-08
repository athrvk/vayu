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
 * A drawer row's hit area must be the whole row the user sees.
 *
 * Three rows - a collection, a request, an environment - are a container `div`
 * that paints the 32px (`h-8`) hover fill, the selection tint and
 * `cursor-pointer`, with the action on a narrower activator button inside it.
 * That split is deliberate and cannot be collapsed: the row carries a ⋯ menu, so
 * it cannot itself be one button, and a plain `<div onClick>` is not keyboard
 * operable (see the comment above the environment row).
 *
 * Two independent gaps opened up between the row and its activator, and each
 * needs its own guard:
 *
 * 1. **Height.** The container is `items-center`, which makes every child
 *    content-height, so the activator was as tall as its label - ~22px in a
 *    request row where the MethodBadge props it open, 18px in a collection or
 *    environment row - inside a 32px row. `self-stretch` overrides the centring.
 * 2. **The row's own box.** The indent is `paddingLeft` *on the row* (so the fill
 *    reaches the panel edge), and the flex gaps and right padding belong to no
 *    child either. `self-stretch` cannot reach any of it, and on a collection row
 *    the indent cannot move onto the button even in principle, because the
 *    chevron sits between them. So the row delegates clicks that land on itself.
 *
 * Measured in the running app at the 260px default drawer width, the share of
 * each row that actually responded before either fix: 41% collection, 51%
 * request, 36% environment.
 *
 * jsdom has no layout, so `offsetHeight` is 0 for every element here and an
 * `offsetHeight` assertion would pass while measuring nothing. The height half is
 * therefore asserted as a class; the delegation half is asserted behaviourally,
 * which is stronger - `fireEvent.click(row)` targets the row itself, exactly the
 * pointer that used to land on dead padding.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import RequestItem from "@/modules/collections/RequestItem";
import CollectionItem from "@/modules/collections/CollectionItem";
import VariablesCategoryTree from "@/modules/variables/sidebar/VariablesCategoryTree";
import { withCollectionTreeContext } from "@/test/collection-tree-context";
import type { Collection, Environment, Request } from "@/types";

const REQUEST: Request = {
	id: "req_1",
	collectionId: "col_1",
	name: "Get user",
	description: "",
	method: "GET",
	url: "https://api.test/user",
	params: [],
	headers: [],
	body: { mode: "none" },
	bodyType: "none",
	auth: { mode: "none" },
	preRequestScript: "",
	postRequestScript: "",
	followRedirects: true,
	maxRedirects: 10,
	httpVersion: "auto",
	order: 0,
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
};

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

const ENVIRONMENT: Environment = {
	id: "env_1",
	name: "Staging",
	description: "",
	variables: {},
	isActive: false,
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
};

const idle = { data: [], isLoading: false, isError: false, refetch: vi.fn() };
const noopMutation = { mutateAsync: vi.fn(), isPending: false };

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => idle,
	useEnvironmentsQuery: () => ({ ...idle, data: [ENVIRONMENT] }),
	useCreateEnvironmentMutation: () => noopMutation,
	useDeleteEnvironmentMutation: () => noopMutation,
	useUpdateEnvironmentMutation: () => noopMutation,
}));

// The environment row's action goes through the store rather than a prop, so
// stub the two stores it touches to get the same kind of spy the other rows
// take as a prop. `VariableCategory` is a type-only import and is erased.
const setSelectedCategory = vi.fn();
vi.mock("@/stores", () => ({ useTabsStore: () => ({ openTab: vi.fn() }) }));
vi.mock("@/modules/variables/variables-store", () => ({
	useVariablesStore: () => ({ selectedCategory: null, setSelectedCategory }),
}));

interface Row {
	/** The element that paints the height, the fill and the indent. */
	row: HTMLElement;
	/** The control that owns the action. */
	activator: HTMLElement;
	/** Called when the row's primary action runs. */
	activated: ReturnType<typeof vi.fn>;
	/**
	 * Called when the row starts a rename. Only the two collection-tree rows
	 * rename on double click; the environment row renames from its ⋯ menu only.
	 */
	renamed?: ReturnType<typeof vi.fn>;
}

function requestRow(): Row {
	const onSelect = vi.fn();
	const onStartRename = vi.fn();
	const { container } = render(
		withCollectionTreeContext(
			<RequestItem request={REQUEST} collectionId="col_1" posInSet={1} setSize={1} />,
			{ onRequestClick: onSelect, onStartRequestRename: onStartRename }
		)
	);
	return {
		row: container.querySelector('[role="treeitem"]') as HTMLElement,
		activator: container.querySelector("[data-tree-activate]") as HTMLElement,
		activated: onSelect,
		renamed: onStartRename,
	};
}

function collectionRow(): Row {
	const onCollectionClick = vi.fn();
	const onStartRename = vi.fn();
	const { container } = render(
		withCollectionTreeContext(
			<CollectionItem collection={COLLECTION} depth={0} posInSet={1} setSize={1} />,
			{ allCollections: [COLLECTION], onCollectionClick, onStartRename }
		)
	);
	return {
		row: container.querySelector('[role="treeitem"]') as HTMLElement,
		activator: container.querySelector("[data-tree-activate]") as HTMLElement,
		activated: onCollectionClick,
		renamed: onStartRename,
	};
}

function environmentRow(): Row {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<VariablesCategoryTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
	// This row has no `data-tree-activate` - it is not part of the collection
	// tree's roving-focus group. Reach it through its label.
	const activator = screen.getByText(ENVIRONMENT.name).closest("button") as HTMLElement;
	return {
		row: activator.parentElement as HTMLElement,
		activator,
		activated: setSelectedCategory,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe.each([
	["request row", requestRow],
	["collection row", collectionRow],
	["environment row", environmentRow],
])("%s", (_label, renderRow) => {
	it("stretches its activator to the full height of the row that paints the fill", () => {
		const { row, activator } = renderRow();

		expect(row).toBeTruthy();
		expect(activator).toBeTruthy();
		// Both halves of the rule together: the row pins its height and centres
		// its children, so the activator has to opt out of that centring.
		expect(row.className).toContain("h-8");
		expect(row.className).toContain("items-center");
		expect(activator.className).toContain("self-stretch");
	});

	it("acts on a click that lands on the row's own box, not on any child", () => {
		const { row, activated } = renderRow();

		// Dispatching on the row *is* the dead-padding pointer: `target` is the
		// row, which is what the browser reports for a click on the indent, a
		// flex gap, or the right padding.
		fireEvent.click(row);

		expect(activated).toHaveBeenCalledTimes(1);
	});

	it("acts exactly once when the click lands on the activator", () => {
		const { activator, activated } = renderRow();

		// The activator's click bubbles through the row, so the row's delegation
		// must recognise it as already handled. Without that check this is 2.
		fireEvent.click(activator);

		expect(activated).toHaveBeenCalledTimes(1);
	});

	it("acts exactly once on the keyboard path", () => {
		const { activator, activated } = renderRow();

		// Not `fireEvent`: the Enter key path is useRovingTreeFocus doing
		// `click("[data-tree-activate]")`, i.e. a native `HTMLElement.click()`.
		// It bubbles too, so it meets the row's delegation the same way - assert
		// that rather than assume the two dispatches behave alike.
		activator.click();

		expect(activated).toHaveBeenCalledTimes(1);
	});
});

/**
 * Delegating `onDoubleClick` as well as `onClick` is what makes a double click on
 * the indent rename, matching a double click on the label. Nothing else covers
 * it, and the environment row is deliberately excluded - it renames from its ⋯
 * menu only, so it has no double-click handler to delegate.
 */
describe.each([
	["request row", requestRow],
	["collection row", collectionRow],
])("%s double click", (_label, renderRow) => {
	it("renames from a double click on the row's own box", () => {
		const { row, renamed } = renderRow();

		fireEvent.doubleClick(row);

		expect(renamed).toHaveBeenCalledTimes(1);
	});
});
