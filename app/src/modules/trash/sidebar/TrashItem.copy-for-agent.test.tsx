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
 * "Copy for agent" on a trash entry (#2047).
 *
 * An icon button, so a copy that landed swaps the glyph to a check and raises
 * no toast (the Copy feedback rule); the line is the formatter's alone.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { useToastStore } from "@/stores";
import type { TrashEntry } from "@/types";
import TrashItem from "./TrashItem";

const SENTINEL = "s3cr3t-sentinel";

const ENTRY: TrashEntry = {
	id: "req_1",
	kind: "request",
	name: "List pets",
	deletedAt: 1700000000000,
	collections: 0,
	requests: 0,
	// Not part of the type; the engine's row may carry more than the view claims.
	...({ url: `https://api.test/pets?token=${SENTINEL}` } as object),
};

const writeText = vi.fn();

beforeEach(() => {
	cleanup();
	writeText.mockReset().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	useToastStore.setState({ toasts: [] });
});

function renderItem(entry: TrashEntry = ENTRY) {
	render(
		<TooltipProvider>
			<TrashItem
				entry={entry}
				onRestore={vi.fn()}
				onPurge={vi.fn()}
				isRestoring={false}
				isPurging={false}
			/>
		</TooltipProvider>
	);
	return screen.getByRole("button", { name: `Copy ${entry.name} for agent` });
}

/** The glyph a button shows now; `IconSwap` keeps the other one invisible beside it. */
function liveGlyph(button: HTMLElement): string {
	return button.querySelector(".enter-fade svg")?.getAttribute("class") ?? "";
}

describe("Copy for agent on a trash entry", () => {
	it("copies the formatter's line", async () => {
		fireEvent.click(renderItem());

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith('Vayu trash entry "List pets" (req_1) - request');
	});

	it("names a collection entry by its kind", async () => {
		fireEvent.click(renderItem({ ...ENTRY, id: "col_1", kind: "collection", name: "Billing" }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith('Vayu trash entry "Billing" (col_1) - collection');
	});

	it("names an environment entry by its kind", async () => {
		fireEvent.click(
			renderItem({
				...ENTRY,
				id: "env_1",
				kind: "environment",
				name: "Staging",
				variables: 4,
			})
		);

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith('Vayu trash entry "Staging" (env_1) - environment');
	});

	it("names an example entry by its kind", async () => {
		fireEvent.click(renderItem({ ...ENTRY, id: "exa_1", kind: "example", name: "Happy path" }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith('Vayu trash entry "Happy path" (exa_1) - example');
	});

	it("swaps the glyph to a check and raises no toast", async () => {
		const button = renderItem();
		expect(liveGlyph(button)).toContain("lucide-copy");

		fireEvent.click(button);

		await waitFor(() => expect(liveGlyph(button)).toContain("lucide-check"));
		expect(useToastStore.getState().toasts).toEqual([]);
	});

	it("keeps everything but the reference off the clipboard", async () => {
		fireEvent.click(renderItem());

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText.mock.calls[0][0]).not.toContain(SENTINEL);
	});

	it("sits beside Restore and Delete forever rather than in a menu", () => {
		renderItem();

		expect(screen.getByRole("button", { name: "Restore List pets" })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Delete List pets forever" })
		).toBeInTheDocument();
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
	});
});
