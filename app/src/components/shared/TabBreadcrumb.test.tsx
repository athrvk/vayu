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
 *   2. **How each segment gives way.** The ancestors truncate down to a 3ch
 *      floor, so a chevron never lands on a first letter; the current crumb
 *      truncates too and carries its full text (#3495). jsdom has
 *      no layout, so the classes are the assertion: `truncate` with a `min-w-*`
 *      is what makes it engage at all inside a flex row.
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

	it("gives ancestors a floor, so a chevron never lands on a label's first letter", () => {
		renderCrumbs([
			{ id: "a", label: "A collection with a very long name indeed", onSelect: () => {} },
			{ id: "b", label: "A folder with a very long name indeed" },
			{ id: "c", label: "List settlements" },
		]);

		const button = screen.getByRole("button");
		const linked = screen.getByText("A collection with a very long name indeed");
		const plain = screen.getByText("A folder with a very long name indeed");
		expect(linked.className).toContain("truncate");
		expect(plain.className).toContain("truncate");
		// The floor is on the flex item that sits beside the chevron.
		expect(button.className).toContain("min-w-[3ch]");
		expect(button.className).toContain("max-w-[16ch]");
		expect(plain.className).toContain("min-w-[3ch]");
		expect(plain.className).toContain("max-w-[16ch]");
		// And no wrapper sits between that item and the shared row, where a
		// `min-w-0` would let the pair shrink below the floor.
		expect(button.parentElement).toBe(plain.parentElement);
		expect(button.parentElement?.className).toContain("min-w-0");
	});

	it("lets the current crumb truncate, with its full text on hover", () => {
		const name = "Create a customer with every optional field filled in";
		renderCrumbs([
			{ id: "a", label: "Acme API", onSelect: () => {} },
			{ id: "c", label: name },
		]);

		const current = screen.getByText(name);
		const classes = current.className.split(/\s+/);
		expect(classes).toEqual(expect.arrayContaining(["truncate", "min-w-0"]));
		expect(classes).not.toContain("shrink-0");
		// `TruncatedText` renders a block box so `truncate` engages; the title it
		// sets only while clipped is covered by its own tests.
		expect(classes).toContain("block");
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
