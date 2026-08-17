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
 * What the preview says about itself (issue #701).
 *
 * The table scrolls inside a fixed-height box, and on overlay-scrollbar
 * platforms a container nobody has scrolled yet draws no scrollbar - so a file
 * of a handful of rows can end at a half-drawn row while the surface says
 * nothing about the rest. The disclosure used to appear only past
 * `PREVIEW_ROWS`, which is exactly the range where it was not needed: a file of
 * more rows than that says "the first 10 of 24" and a file of eight said
 * nothing at all.
 *
 * jsdom has no layout, so none of this can be measured here - what is asserted
 * is the sentence, and the declarations that make the box a scroller rather
 * than something that widens its host.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import DataFilePicker, { type SelectedDataFile } from "./DataFilePicker";

vi.mock("@/queries", () => ({
	useConfigQuery: () => ({ data: { entries: [] as { key: string; value: string }[] } }),
}));

/** A selection of `count` rows over the issue's seven-column shape. */
function selection(count: number): SelectedDataFile {
	const columns = ["userId", "email", "plan", "quantity", "orderRef", "city", "delayMs"];
	return {
		fileName: "orders.csv",
		parsed: {
			format: "csv",
			columns,
			warnings: [],
			rows: Array.from({ length: count }, (_, i) => ({
				userId: `u_${i}`,
				email: `dana.whitfield+${i}@example.com`,
				plan: "enterprise",
				quantity: "3",
				orderRef: `ord_8f2c1a9${i}`,
				city: "Portland, OR",
				delayMs: "250",
			})),
		},
	} as SelectedDataFile;
}

function renderWith(rows: number) {
	return render(
		<DataFilePicker
			selected={selection(rows)}
			onSelect={vi.fn()}
			error={null}
			onError={vi.fn()}
			iterations={undefined}
		/>
	);
}

describe("what the preview discloses about its own rows", () => {
	it("says a short file is shown whole, and that the table is what scrolls", () => {
		renderWith(8);

		// The case that said nothing before: eight rows, all of them in the
		// table, more than the box is tall.
		expect(screen.getByText(/showing all 8 rows/i)).toBeTruthy();
		expect(screen.getByText(/scroll the table if they do not fit/i)).toBeTruthy();
	});

	it("still names the cut when the file is longer than the preview", () => {
		renderWith(24);

		expect(screen.getByText(/showing the first 10 of 24 rows/i)).toBeTruthy();
		expect(screen.queryByText(/showing all/i)).toBeNull();
	});

	it("says nothing for a single row, which a box this tall cannot cut off", () => {
		renderWith(1);

		expect(screen.queryByText(/showing all/i)).toBeNull();
		expect(screen.queryByText(/showing the first/i)).toBeNull();
	});
});

describe("the preview box is a scroller, not something that widens its host", () => {
	it("bounds its own height and scrolls in both axes", () => {
		const { container } = renderWith(8);

		// The table is wide by construction (seven `whitespace-nowrap` columns);
		// what keeps it from pushing the dialog's controls off the panel is that
		// this box scrolls. Its own declarations are all this component can
		// promise - the ancestor that would otherwise be sized from the table's
		// min-content is the host's (see `RunCollectionDialog.layout.test.tsx`).
		const wrapper = container.querySelector(".overflow-auto");
		expect(wrapper).toBeTruthy();
		expect(wrapper?.className).toContain("max-h-56");
		expect(wrapper?.querySelector("table")).toBeTruthy();
	});

	it("keeps every cell on one line, which is what makes the box need to scroll", () => {
		const { container } = renderWith(2);

		const cells = Array.from(container.querySelectorAll("th, td"));
		expect(cells.length).toBeGreaterThan(0);
		for (const cell of cells) {
			expect(cell.className).toContain("whitespace-nowrap");
		}
	});
});
