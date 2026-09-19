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
 * The crumb row every detail tab draws (#1691).
 *
 * Three things here are easy to get wrong and invisible in review:
 *
 *   1. **The empty band.** A row that renders whether or not it has anything to
 *      show is what the builder's description band charged every request ~30px
 *      for until it became the Info tab. Nothing to say must mean no element,
 *      not an element with no text - and only absence can be asserted for.
 *   2. **Which segment gives way.** The last crumb is where you are, so the
 *      ancestors truncate and it does not. jsdom has no layout, so the classes
 *      are the assertion: `min-w-0` + `truncate` is what makes `truncate`
 *      engage at all inside a flex row, and `shrink-0` on the current crumb is
 *      what keeps it out of the negotiation.
 *   3. **Only a crumb with somewhere to go is a control.** The current crumb is
 *      inert, and so is an ancestor the caller gave no handler - a button that
 *      does nothing is worse than text.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TabBreadcrumb, type BreadcrumbCrumb } from "./TabBreadcrumb";

const row = () => screen.queryByRole("navigation", { name: "Collection location" });

function renderCrumbs(crumbs: BreadcrumbCrumb[]) {
	return render(<TabBreadcrumb label="Collection location" crumbs={crumbs} />);
}

describe("TabBreadcrumb", () => {
	it("renders the chain in order, ancestors first", () => {
		renderCrumbs([
			{ id: "a", label: "Acme API", onSelect: () => {} },
			{ id: "b", label: "Payouts", onSelect: () => {} },
			{ id: "c", label: "List settlements" },
		]);

		// Read off the whole row rather than segment by segment: separate
		// `getByText`s pass just as well on a leaf-first chain.
		expect(row()?.textContent).toBe("Acme APIPayoutsList settlements");
	});

	it("navigates from an ancestor crumb", () => {
		const onSelect = vi.fn();
		renderCrumbs([
			{ id: "a", label: "Acme API", onSelect },
			{ id: "c", label: "Payouts" },
		]);

		screen.getByRole("button", { name: "Acme API" }).click();

		expect(onSelect).toHaveBeenCalledTimes(1);
	});

	it("leaves the current crumb inert, and an ancestor with nowhere to go", () => {
		renderCrumbs([
			{ id: "view", label: "History" },
			{ id: "a", label: "Acme API", onSelect: () => {} },
			{ id: "c", label: "List settlements" },
		]);

		// One button for the one crumb that was given a handler.
		expect(screen.getAllByRole("button")).toHaveLength(1);
		expect(screen.getByText("History").tagName).not.toBe("BUTTON");
	});

	it("truncates ancestors and never the current crumb", () => {
		renderCrumbs([
			{ id: "a", label: "A collection with a very long name indeed", onSelect: () => {} },
			{ id: "c", label: "List settlements" },
		]);

		const ancestor = screen.getByText("A collection with a very long name indeed");
		expect(ancestor.className).toContain("truncate");
		expect(screen.getByRole("button").className).toContain("min-w-0");

		const current = screen.getByText("List settlements");
		expect(current.className).toContain("shrink-0");
		expect(current.className).not.toContain("truncate");
	});

	it("drops blank labels rather than drawing an empty segment", () => {
		renderCrumbs([
			{ id: "a", label: "Acme API", onSelect: () => {} },
			{ id: "c", label: "  " },
		]);

		// The collection becomes the current crumb, and nothing trails it.
		expect(row()?.textContent).toBe("Acme API");
		expect(screen.queryAllByRole("button")).toHaveLength(0);
	});

	it("renders no band at all when there is nothing to show", () => {
		renderCrumbs([{ id: "c", label: "   " }]);

		// Not "renders empty" - an empty flex row still costs its padding, which
		// is the permanent band this deliberately does not draw.
		expect(row()).toBeNull();
	});
});
