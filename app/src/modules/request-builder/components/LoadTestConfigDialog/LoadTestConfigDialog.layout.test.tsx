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
 * The dialog is two panes from `lg` and keeps Start and its notices on screen
 * (issue #2231).
 *
 * jsdom has no layout, so what is asserted is the declaration on the element
 * that carries it and where each node sits in the tree, per the rule in
 * app/CLAUDE.md.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import LoadTestConfigDialog from "./index";

vi.mock("../OAuth2LoadTestGuard", () => ({ default: () => null }));
vi.mock("@/queries", () => ({
	useConfigQuery: () => ({ data: { entries: [] } }),
	useCollectionsQuery: () => ({ data: [] }),
	useFullCollectionRequests: () => ({ requestsByCollection: new Map(), isLoading: false }),
	useRequestDefaultsQuery: () => ({ data: { headers: [] } }),
}));
vi.mock("@/queries/collections", () => ({
	useUpdateCollectionMutation: () => ({
		mutate: vi.fn(),
		isPending: false,
		isError: false,
		error: null,
	}),
	useDataFileReadingMutation: () => ({
		mutate: vi.fn(),
		isPending: false,
		isError: false,
		error: null,
	}),
}));
vi.mock("@/services/data-files/read-declared", () => ({
	canReadDeclaredDataFile: () => false,
	readDeclaredDataFile: vi.fn(),
}));

function open(props: Partial<React.ComponentProps<typeof LoadTestConfigDialog>> = {}) {
	render(
		<LoadTestConfigDialog
			onClose={vi.fn()}
			onStart={vi.fn()}
			isStarting={false}
			hasPreRequestScript={false}
			hasPostRequestScript={false}
			isStreamingRequest={false}
			{...props}
		/>,
		{ wrapper: TooltipProvider }
	);
	const slot = (name: string) => document.querySelector<HTMLElement>(`[data-slot="${name}"]`);
	const panel = slot("dialog-content");
	const body = slot("dialog-body");
	const footer = slot("dialog-footer");
	expect(panel).toBeTruthy();
	expect(body).toBeTruthy();
	expect(footer).toBeTruthy();
	return { panel: panel!, body: body!, footer: footer!, slot };
}

/** A notice that is real: a pre-request script that will not run. */
const NOTICE = "Pre-request script won't run";

beforeEach(() => {
	cleanup();
	localStorage.clear();
});

describe("the load-test dialog layout", () => {
	it("widens to the two-pane size at lg and stays a single column below it", () => {
		const { panel } = open();
		expect(panel.className).toContain("lg:max-w-4xl");
		// The unprefixed cap is the single-column width below `lg`.
		expect(panel.className).toContain("max-w-xl");
	});

	it("pins the notices in a band beside the body, not inside the scroller", () => {
		const { panel, body, slot } = open({ hasPreRequestScript: true });
		const band = slot("load-test-notices");
		const notice = screen.getByText(NOTICE);

		expect(band).toBeTruthy();
		expect(band!.contains(notice)).toBe(true);
		expect(body.contains(notice)).toBe(false);
		// Siblings under the panel: the band neither scrolls with the body nor
		// sits in the header.
		expect(band!.parentElement).toBe(panel);
		expect(body.parentElement).toBe(panel);
		expect(band!.className).toContain("shrink-0");
		expect(band!.className).toContain("max-h-[30vh]");
		expect(band!.className).toContain("overflow-y-auto");
	});

	it("renders no band once there is nothing left to say", () => {
		// A fresh dialog carries the SLO-seeded p99 budget, which is a notice;
		// clearing it is the way to an empty list.
		const { slot } = open();
		expect(slot("load-test-notices")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Clear carried-over budgets" }));
		expect(slot("load-test-notices")).toBeNull();
	});

	it("lays the body out as two columns at lg, the profile on the left and the rest on the right", () => {
		const { body } = open();
		const grid = body.querySelector<HTMLElement>(":scope > .grid");
		expect(grid).toBeTruthy();
		expect(grid!.className).toContain("lg:grid-cols-2");

		const columns = Array.from(grid!.children) as HTMLElement[];
		expect(columns).toHaveLength(2);
		const [left, right] = columns;

		expect(left.contains(screen.getByLabelText(/run label/i))).toBe(true);
		expect(left.contains(screen.getByRole("radiogroup", { name: /load profile/i }))).toBe(true);
		for (const title of ["Recording & limits", "Pass/fail budgets", "Server monitoring"]) {
			expect(right.contains(screen.getByText(title))).toBe(true);
			expect(left.contains(screen.getByText(title))).toBe(false);
		}
		// `min-w-0` on each column, or a wide child stretches its track.
		for (const column of columns) expect(column.className).toContain("min-w-0");
	});

	it("keeps Start in the footer, outside the scroller", () => {
		const { body, footer } = open();
		const start = screen.getByRole("button", { name: "Start" });
		expect(footer.contains(start)).toBe(true);
		expect(body.contains(start)).toBe(false);
	});
});
