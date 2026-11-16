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
 * A collection row's two exports, from its ⋯ menu.
 *
 * `RowAction` is one flat list, so the two formats sit side by side rather
 * than under a submenu; what this locks is that each entry mounts its own
 * dialog, for the row it was chosen on. The dialogs are stubbed - what each
 * says is asserted in its own file.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useTabsStore } from "@/stores";
import type { Collection } from "@/types";
import { useCollectionsStore } from "./collections-store";
import CollectionTree from "./CollectionTree";
import { menuClosedAndFocusSettled } from "@/test/menu-focus.testkit";

const collections = [{ id: "acme", name: "Acme", order: 0 }];

vi.mock("@/queries", () => ({
	useReorderMutation: () => ({ mutate: vi.fn(), isPending: false }),
	useCollectionsQuery: () => ({
		data: collections,
		isLoading: false,
		isError: false,
		error: null,
		refetch: vi.fn(),
	}),
	useMultipleCollectionRequests: () => ({ requestsByCollection: new Map() }),
	useCreateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useCreateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useMockServersQuery: () => ({ data: [] }),
}));

/**
 * What the real dialogs do when they close: hand Radix's close event to the
 * caller's `onCloseAutoFocus` before they unmount. The stub keeps that seam and
 * nothing else.
 */
interface StubProps {
	collection: Collection;
	onOpenChange: (open: boolean) => void;
	onCloseAutoFocus?: (event: Event) => void;
}
function StubDialog({ label, props }: { label: string; props: StubProps }) {
	return (
		<>
			<p data-testid="export-dialog">
				{label} of {props.collection.name}
			</p>
			<button
				type="button"
				onClick={() => {
					props.onCloseAutoFocus?.(new Event("focus", { cancelable: true }));
					props.onOpenChange(false);
				}}
			>
				Close stub
			</button>
		</>
	);
}

vi.mock("./ExportSpecDialog", () => ({
	default: (props: StubProps) => <StubDialog label="OpenAPI export" props={props} />,
}));
vi.mock("./ExportPostmanDialog", () => ({
	default: (props: StubProps) => <StubDialog label="Postman export" props={props} />,
}));

function renderTree() {
	return render(
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
		>
			<TooltipProvider>
				<CollectionTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

/** Open the Acme row's menu the way the keyboard does (#1212). */
async function openRowMenu() {
	const row = document.querySelector<HTMLElement>('[data-collection-id="acme"]')!;
	row.focus();
	fireEvent.keyDown(row, { key: "F10", shiftKey: true });
	return await screen.findByRole("menu");
}

beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn();
	useCollectionsStore.setState({ expandedCollectionIds: new Set() });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});

describe("a collection row's export entries", () => {
	it("lists the Postman export directly under the OpenAPI one", async () => {
		renderTree();
		await openRowMenu();

		const labels = screen.getAllByRole("menuitem").map((item) => item.textContent);
		const openapi = labels.indexOf("Export as OpenAPI");
		expect(openapi).toBeGreaterThan(-1);
		expect(labels[openapi + 1]).toBe("Export as Postman Collection");
	});

	it.each([
		["Export as OpenAPI", "OpenAPI export of Acme"],
		["Export as Postman Collection", "Postman export of Acme"],
	])("%s mounts its own dialog for the row", async (entry, dialog) => {
		renderTree();
		await openRowMenu();

		fireEvent.click(screen.getByRole("menuitem", { name: entry }));

		const mounted = await screen.findAllByTestId("export-dialog");
		expect(mounted.map((node) => node.textContent)).toEqual([dialog]);
	});

	// The dialog opens from a menu item that closes with its menu, so Radix's own
	// restore lands on `<body>` (#3443). The row it was opened over is where
	// focus belongs.
	it.each([["Export as OpenAPI"], ["Export as Postman Collection"]])(
		"%s hands focus back to the row it was opened over",
		async (entry) => {
			renderTree();
			await openRowMenu();
			fireEvent.click(screen.getByRole("menuitem", { name: entry }));
			await screen.findByTestId("export-dialog");
			await menuClosedAndFocusSettled();
			// The real dialog holds focus while it is open; the stub has no trap.
			(document.activeElement as HTMLElement).blur();

			fireEvent.click(screen.getByRole("button", { name: "Close stub" }));

			await waitFor(() =>
				expect(document.activeElement).toBe(
					document.querySelector('[data-collection-id="acme"]')
				)
			);
		}
	);
});
