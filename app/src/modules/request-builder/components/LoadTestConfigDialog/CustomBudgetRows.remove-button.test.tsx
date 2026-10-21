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
 * A custom budget row's remove control is a row action (#2314): it hovers its
 * glyph to destructive on the same `accent-active` fill as the copy beside it,
 * where `ghost` hovered to the fill the row underneath already paints.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CustomBudgetRows } from "./CustomBudgetRows";
import type { CustomBudgetDraft } from "./budgets";

const ROW: CustomBudgetDraft = { id: "row_1", name: "checkout_ttfb", stat: "p95", value: "4817" };

describe("CustomBudgetRows remove button", () => {
	it("uses the destructive row-action hover, not the ghost fill", () => {
		render(<CustomBudgetRows rows={[ROW]} onChange={() => {}} idPrefix="t" />);
		const remove = screen.getByRole("button", { name: "Remove custom budget 1" });
		expect(remove.className).toContain("hover:text-destructive-text");
		expect(remove.className).toContain("hover:bg-accent-active");
	});

	it("still removes its row", () => {
		const onChange = vi.fn();
		render(<CustomBudgetRows rows={[ROW]} onChange={onChange} idPrefix="t" />);
		fireEvent.click(screen.getByRole("button", { name: "Remove custom budget 1" }));
		expect(onChange).toHaveBeenCalledWith([]);
	});
});
