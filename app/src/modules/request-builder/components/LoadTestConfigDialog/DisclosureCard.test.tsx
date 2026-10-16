/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DisclosureCard } from "./DisclosureCard";

afterEach(cleanup);

const card = (open: boolean, summary?: string) =>
	render(
		<DisclosureCard
			open={open}
			onOpenChange={() => {}}
			title="Pass/fail budgets"
			summary={summary}
		>
			<p>contents</p>
		</DisclosureCard>
	);

describe("DisclosureCard summary", () => {
	it("is on the trigger while the card is closed, and the contents are not", () => {
		card(false, "2 budgets active");
		expect(screen.getByRole("button")).toHaveTextContent("Pass/fail budgets");
		expect(screen.getByRole("button")).toHaveTextContent("2 budgets active");
		expect(screen.getByRole("button")).toHaveTextContent("Show");
		expect(screen.queryByText("contents")).not.toBeInTheDocument();
	});

	it("stays on the trigger while the card is open", () => {
		card(true, "2 budgets active");
		expect(screen.getByRole("button")).toHaveTextContent("2 budgets active");
		expect(screen.getByRole("button")).toHaveTextContent("Hide");
		expect(screen.getByText("contents")).toBeInTheDocument();
	});

	it("leaves the trigger as title and Show when there is none", () => {
		card(false);
		expect(screen.getByRole("button")).toHaveTextContent(/^Pass\/fail budgetsShow$/);
	});
});
