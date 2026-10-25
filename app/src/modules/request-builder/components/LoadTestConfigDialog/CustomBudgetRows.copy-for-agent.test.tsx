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
 * "Copy for agent" on a budget row of the load test dialog (#2047): the six
 * fixed fields and each named custom row, keyed the way the payload keys them
 * (`budgets.ts`), of the saved request that owns them. The collection runner
 * mounts the same rows with no request, and shows none.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useToastStore } from "@/stores";
import type { ThresholdOwner } from "@/lib/agent-reference";
import { BudgetsSection } from "./BudgetsSection";
import { CustomBudgetRows } from "./CustomBudgetRows";
import { BUDGET_FIELDS, emptyBudgetDraft, type CustomBudgetDraft } from "./budgets";

const OWNER: ThresholdOwner = {
	type: "request",
	request: { id: "req_7", name: 'Create "order"' },
};

// Odd enough that it cannot appear in a line by accident.
const CEILING = "4817";

const row = (over: Partial<CustomBudgetDraft> = {}): CustomBudgetDraft => ({
	id: "row_1",
	name: "checkout_ttfb",
	stat: "p95",
	value: CEILING,
	...over,
});

const writeText = vi.fn();

beforeEach(() => {
	cleanup();
	writeText.mockReset().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	useToastStore.setState({ toasts: [] });
});

function renderRows(rows: CustomBudgetDraft[], owner: ThresholdOwner | null = OWNER) {
	return render(
		<CustomBudgetRows
			rows={rows}
			onChange={() => {}}
			idPrefix="t"
			referenceOwner={owner ?? undefined}
		/>
	);
}

const copyButton = (name: string) => screen.queryByRole("button", { name });

/** The glyph a button shows now; `IconSwap` keeps the other one invisible beside it. */
function liveGlyph(button: HTMLElement): string {
	return button.querySelector(".enter-fade svg")?.getAttribute("class") ?? "";
}

describe("Copy for agent on a custom budget row", () => {
	it("copies custom.<name>.<stat> of the saved request", async () => {
		renderRows([row()]);

		fireEvent.click(copyButton("Copy custom budget 1 for agent")!);

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith(
			'Vayu threshold "custom.checkout_ttfb.p95" of request "Create \\"order\\"" (req_7)'
		);
	});

	it("follows the stat and the trimmed name", async () => {
		renderRows([row({ name: "  checkout_ttfb ", stat: "max" })]);

		fireEvent.click(copyButton("Copy custom budget 1 for agent")!);

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText.mock.calls[0][0]).toContain('"custom.checkout_ttfb.max"');
	});

	it("swaps the glyph to a check and raises no toast", async () => {
		renderRows([row()]);
		const button = copyButton("Copy custom budget 1 for agent")!;
		expect(liveGlyph(button)).toContain("lucide-copy");

		fireEvent.click(button);

		await waitFor(() => expect(liveGlyph(button)).toContain("lucide-check"));
		expect(useToastStore.getState().toasts).toEqual([]);
	});

	it("keeps the ceiling off the clipboard", async () => {
		renderRows([row()]);

		fireEvent.click(copyButton("Copy custom budget 1 for agent")!);

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText.mock.calls[0][0]).not.toContain(CEILING);
	});

	it("is absent for a row with no name yet", () => {
		renderRows([row({ name: "   " })]);

		expect(copyButton("Copy custom budget 1 for agent")).toBeNull();
	});

	it("is absent when no request owns the budgets", () => {
		renderRows([row()], null);

		expect(screen.getByLabelText("Custom budget 1 metric name")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /for agent$/ })).toBeNull();
	});

	it("keeps the caption row as wide as the row beneath it", () => {
		// The caption holds a spacer for each trailing column; a column added to
		// the rows without one pushes the captions out of line with the fields.
		const columns = (owner: ThresholdOwner | null) => {
			const { container, unmount } = renderRows([row()], owner);
			const caption = container.querySelector("[aria-hidden='true']")!;
			const field = screen.getByLabelText("Custom budget 1 metric name").parentElement!;
			const counts = [caption.children.length, field.children.length];
			unmount();
			return counts;
		};

		expect(columns(OWNER)).toEqual([5, 5]);
		expect(columns(null)).toEqual([4, 4]);
	});
});

describe("Copy for agent on a fixed budget field", () => {
	function renderSection(referenceOwner?: ThresholdOwner) {
		render(
			<BudgetsSection
				mode="constant_concurrency"
				budgetSources={{}}
				budgets={emptyBudgetDraft()}
				onBudgetsChange={() => {}}
				customBudgets={[row()]}
				onCustomBudgetsChange={() => {}}
				failRun={false}
				onFailRunChange={() => {}}
				disabled={false}
				referenceOwner={referenceOwner}
			/>
		);
		fireEvent.click(screen.getByRole("button", { name: /budgets/i }));
	}

	it("copies each field under the key the payload sends", async () => {
		renderSection(OWNER);

		for (const field of BUDGET_FIELDS) {
			fireEvent.click(copyButton(`Copy ${field.label} for agent`)!);
		}

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(BUDGET_FIELDS.length));
		expect(writeText.mock.calls.map(([line]) => line)).toEqual(
			BUDGET_FIELDS.map(
				(field) => `Vayu threshold "${field.key}" of request "Create \\"order\\"" (req_7)`
			)
		);
	});

	it("hands the owner on to the custom rows beneath them", () => {
		renderSection(OWNER);

		expect(copyButton("Copy custom budget 1 for agent")).toBeInTheDocument();
	});

	it("is absent when no request owns the budgets", () => {
		renderSection(undefined);

		expect(screen.getByLabelText(/p50 latency at most/i)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /for agent$/ })).toBeNull();
	});
});
