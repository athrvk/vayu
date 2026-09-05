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
 * The Info tab drafts `{name, description}` as one object through
 * `useEntityDraft`, so a naive fix for #1437 (never reseed while dirty) would
 * make an agent's *unrelated* field edit invisible for as long as the user is
 * typing anywhere on the tab. These pin the per-key merge instead: a field the
 * user has not touched still adopts an agent's change immediately, and only a
 * field both sides touched shows a conflict.
 *
 * On today's unfixed `useEntityDraft`, every case below fails the same way -
 * the whole-object reseed either wipes the user's edit (the untouched-field
 * cases would instead show the *old* value going stale forever, since it
 * simply never resyncs while dirty) or silently drops the agent's write.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { Collection } from "@/types";

const mutation = {
	mutateAsync: vi.fn(() => Promise.resolve()),
	mutate: vi.fn(),
	reset: vi.fn(),
	isPending: false,
	isError: false,
};

vi.mock("@/queries/collections", () => ({
	useUpdateCollectionMutation: () => mutation,
}));

const { default: InfoTab } = await import("./InfoTab");
await import("@/components/ui/markdown-renderer");

const collection = {
	id: "c1",
	name: "Acme API",
	description: "Payout endpoints.",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-02T00:00:00Z",
} as unknown as Collection;

const nameField = () => screen.getByLabelText("Collection name") as HTMLInputElement;

async function renderTab(props: Partial<Collection> = {}) {
	const utils = render(
		<TooltipProvider>
			<InfoTab collection={{ ...collection, ...props }} requestCount={0} />
		</TooltipProvider>
	);
	await act(async () => {});
	return utils;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("InfoTab - a background rename or edit while the tab is dirty", () => {
	it("adopts an untouched field's agent edit while keeping the field the user typed", async () => {
		const { rerender } = await renderTab();

		fireEvent.change(nameField(), { target: { value: "Acme Payouts (draft)" } });

		// The agent only touched description; name is untouched by it.
		await act(async () => {
			rerender(
				<TooltipProvider>
					<InfoTab
						collection={{ ...collection, description: "Written by an agent." }}
						requestCount={0}
					/>
				</TooltipProvider>
			);
		});

		expect(nameField().value).toBe("Acme Payouts (draft)");
		expect(screen.getByText("Written by an agent.")).toBeInTheDocument();
		expect(screen.queryByText(/Changed elsewhere/)).not.toBeInTheDocument();
	});

	it("shows a conflict when both sides touch the same field, and keeps the user's edit", async () => {
		const { rerender } = await renderTab();

		fireEvent.change(nameField(), { target: { value: "Renamed by user" } });

		await act(async () => {
			rerender(
				<TooltipProvider>
					<InfoTab
						collection={{ ...collection, name: "Renamed by agent" }}
						requestCount={0}
					/>
				</TooltipProvider>
			);
		});

		expect(nameField().value).toBe("Renamed by user");
		expect(screen.getByText("Changed elsewhere: name")).toBeInTheDocument();
	});

	it("shows a conflict on description too, the same as name", async () => {
		const { container, rerender } = await renderTab();

		// Click into the rendered markdown to reveal the source textarea, the
		// same way InfoTab.markdown.test.tsx does.
		fireEvent.click(container.querySelector('[role="button"]') as HTMLElement);
		const descriptionField = screen.getByLabelText(
			"Collection description"
		) as HTMLTextAreaElement;
		fireEvent.change(descriptionField, { target: { value: "Written by the user" } });

		await act(async () => {
			rerender(
				<TooltipProvider>
					<InfoTab
						collection={{ ...collection, description: "Written by an agent" }}
						requestCount={0}
					/>
				</TooltipProvider>
			);
		});

		expect(descriptionField.value).toBe("Written by the user");
		expect(screen.getByText("Changed elsewhere: description")).toBeInTheDocument();
	});

	it("Take theirs adopts the agent's value and clears the conflict", async () => {
		const { rerender } = await renderTab();

		fireEvent.change(nameField(), { target: { value: "Renamed by user" } });
		await act(async () => {
			rerender(
				<TooltipProvider>
					<InfoTab
						collection={{ ...collection, name: "Renamed by agent" }}
						requestCount={0}
					/>
				</TooltipProvider>
			);
		});

		fireEvent.click(screen.getByRole("button", { name: /take theirs/i }));

		expect(nameField().value).toBe("Renamed by agent");
		expect(screen.queryByText(/Changed elsewhere/)).not.toBeInTheDocument();
	});

	it("a clean tab still adopts an agent's change immediately, as before", async () => {
		const { rerender } = await renderTab();

		await act(async () => {
			rerender(
				<TooltipProvider>
					<InfoTab
						collection={{ ...collection, name: "Renamed by agent" }}
						requestCount={0}
					/>
				</TooltipProvider>
			);
		});

		expect(nameField().value).toBe("Renamed by agent");
	});
});
