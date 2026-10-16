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
 * What the extracted sections do at their own prop boundary. The dialog's
 * suite drives them through the whole form with `isStarting` always false, so
 * the one branch it cannot reach - a section told it is disabled - is pinned
 * here.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { BudgetsSection } from "./BudgetsSection";
import { emptyBudgetDraft, emptyCustomBudgetRow } from "./budgets";

afterEach(cleanup);

function renderBudgets(disabled: boolean) {
	render(
		<BudgetsSection
			budgets={emptyBudgetDraft()}
			onBudgetsChange={() => {}}
			customBudgets={[emptyCustomBudgetRow()]}
			onCustomBudgetsChange={() => {}}
			failRun={false}
			onFailRunChange={() => {}}
			disabled={disabled}
		/>
	);
	fireEvent.click(screen.getByRole("button", { name: /pass\/fail budgets/i }));
}

describe("BudgetsSection", () => {
	it("locks the custom rows while the run is starting", () => {
		renderBudgets(true);
		expect(screen.getByLabelText(/custom budget 1 metric name/i)).toBeDisabled();
		expect(screen.getByLabelText(/custom budget 1 ceiling/i)).toBeDisabled();
		expect(screen.getByRole("button", { name: /remove custom budget 1/i })).toBeDisabled();
		expect(screen.getByRole("button", { name: /add custom metric budget/i })).toBeDisabled();
	});

	it("leaves the custom rows editable otherwise", () => {
		renderBudgets(false);
		expect(screen.getByLabelText(/custom budget 1 metric name/i)).toBeEnabled();
		expect(screen.getByRole("button", { name: /add custom metric budget/i })).toBeEnabled();
	});
});
