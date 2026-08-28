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
 * A duplicated request lands next to the one it was copied from (issue #360).
 *
 * The engine now appends a created request that states no `order`, which is
 * right for "New request" and wrong for "Duplicate" - a copy that jumps to the
 * bottom of a long collection reads as a failed action. The copy therefore
 * states its source's own `order`, and the shared tie rule (`compareTreeOrder`:
 * order, then createdAt, then id) puts the newer row immediately after. No
 * sibling is renumbered, so this needs no multi-row write.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useCollectionsStore } from "./collections-store";
import { compareTreeOrder } from "@/types";
import CollectionTree from "./CollectionTree";

const createRequest = vi.fn();

const collection = { id: "c1", name: "Acme API", order: 0 };
// The source sits in the middle, so "appended" and "adjacent" are different
// outcomes rather than the same one by accident.
const first = { id: "r0", collectionId: "c1", name: "First", method: "GET", order: 0 };
const source = {
	id: "r1",
	collectionId: "c1",
	name: "Get users",
	method: "GET",
	order: 1,
	description: "d",
	createdAt: "2026-01-01T00:00:00.000Z",
};
const last = { id: "r2", collectionId: "c1", name: "Last", method: "GET", order: 2 };

vi.mock("@/queries", () => ({
	useReorderMutation: () => ({ mutate: vi.fn(), isPending: false }),
	useCollectionsQuery: () => ({
		data: [collection],
		isLoading: false,
		isError: false,
		error: null,
		refetch: vi.fn(),
	}),
	useMultipleCollectionRequests: () => ({
		requestsByCollection: new Map([["c1", [first, source, last]]]),
	}),
	useCreateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useCreateRequestMutation: () => ({ mutateAsync: createRequest, isPending: false }),
	useDeleteRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

function renderTree() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<CollectionTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	createRequest.mockReset();
	createRequest.mockResolvedValue({ id: "r1_copy", collectionId: "c1" });
	useCollectionsStore.setState({ expandedCollectionIds: new Set(["c1"]) });
});

describe("duplicating a request", () => {
	it("sends the source's order rather than leaving it to the engine's append", async () => {
		renderTree();

		const row = document.querySelector<HTMLElement>('[data-request-id="r1"]')!;
		// Radix opens its dropdown on pointerdown, not click.
		fireEvent.pointerDown(
			within(row, /more/i),
			new PointerEvent("pointerdown", { bubbles: true, button: 0 })
		);
		fireEvent.click(await screen.findByText("Duplicate"));

		await waitFor(() => expect(createRequest).toHaveBeenCalled());
		const sent = createRequest.mock.calls[0][0];
		expect(sent.order).toBe(source.order);
		expect(sent.name).toBe("Get users (Copy)");
	});

	it("that order places the copy directly after its source, not at the end", () => {
		// The rule the choice above relies on, applied to what the engine would
		// send back: same order, newer createdAt.
		const copy = {
			id: "r1_copy",
			order: source.order,
			createdAt: "2026-06-01T00:00:00.000Z",
		};
		const sorted = [first, source, last, copy].sort(compareTreeOrder);
		expect(sorted.map((r) => r.id)).toEqual(["r0", "r1", "r1_copy", "r2"]);
	});
});

/** The row's "⋯" trigger - it is the only button in the row besides the row itself. */
function within(row: HTMLElement, name: RegExp): HTMLElement {
	const buttons = Array.from(row.querySelectorAll("button"));
	const match = buttons.find((b) => name.test(b.getAttribute("aria-label") ?? ""));
	if (!match) {
		throw new Error(
			`no button matching ${name} in row; saw: ${buttons
				.map((b) => b.getAttribute("aria-label"))
				.join(", ")}`
		);
	}
	return match;
}
