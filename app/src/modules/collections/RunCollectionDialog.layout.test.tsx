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
 * The dialog panel keeps its content inside itself (issue #701).
 *
 * Observed with an ordinary seven-column CSV: the panel painted at its
 * configured width while its content laid out roughly twice as wide, so the
 * toggles, the Iterations field, the data file's Remove button and the
 * Cancel/Run footer all rendered outside the panel, over the dimmed backdrop.
 *
 * The mechanism is the grid: `DialogContent` is a grid whose single track is
 * `auto`, and an auto track's minimum is its items' min-content - so the
 * preview table's min-content grew the track past the panel's `max-w`, which
 * cannot follow it. Every row in that grid then lays out at the track's width,
 * which is why controls that had nothing to do with the table moved. Making the
 * table's wrapper `overflow-auto` does not prevent this: it bounds the box, not
 * the min-content width the box contributes upward.
 *
 * jsdom reports 0 for every measurement, so what is asserted here is the
 * declaration that fixes it, on the element that carries it - measured
 * separately in a real engine, where seven columns spilled the footer 428px
 * past the painted edge before the clamp and 0px after it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import RunCollectionDialog from "./RunCollectionDialog";
import { useSessionStore, useTabsStore } from "@/stores";
import type { Collection } from "@/types";

const startRunState = { mutate: vi.fn(), isPending: false, error: null as Error | null };

vi.mock("@/queries", () => ({
	useStartScenarioRunMutation: () => startRunState,
	useConfigQuery: () => ({ data: { entries: [] as { key: string; value: string }[] } }),
}));

vi.mock("@/services", () => ({
	scenarioRunService: { startMonitoring: vi.fn() },
	loadTestService: { startMonitoring: vi.fn() },
}));

const COLLECTION = { id: "col_1", name: "Checkout flow", parentId: null } as unknown as Collection;

beforeEach(() => {
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useSessionStore.setState({ activeEnvironmentId: null });
});

describe("the run dialog's panel", () => {
	it("clamps its grid track so no descendant can widen it past the painted panel", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);

		const panel = document.querySelector('[data-slot="dialog-content"]');
		expect(panel).toBeTruthy();

		// `grid-cols-1` is `repeat(1, minmax(0, 1fr))`, and the 0 is the whole
		// fix: it lets the track be smaller than its content's min-content, which
		// is what hands the scrollers inside it something to scroll within. The
		// arbitrary `grid-cols-[minmax(0,1fr)]` would say it more plainly and
		// compiles to nothing, so this asserts the utility that has a rule.
		expect(panel?.className).toContain("grid-cols-1");
		expect(panel?.className).toContain("grid");
	});

	it("still caps the panel's own width - the clamp is not a licence to grow", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);

		const panel = document.querySelector('[data-slot="dialog-content"]');
		// The bug was never that the panel was too narrow. Widening it would have
		// traded a dialog whose controls sit outside it for one that is as wide
		// as whatever file was picked.
		expect(panel?.className).toContain("sm:max-w-md");
	});

	it("keeps the footer a child of the panel it is painted in", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);

		const panel = document.querySelector('[data-slot="dialog-content"]');
		const footer = document.querySelector('[data-slot="dialog-footer"]');
		// What the user saw was the footer beside the panel rather than in it.
		// It was always a descendant; the track it sat in was what escaped - so
		// this pins the relationship the clamp is there to keep honest.
		expect(footer).toBeTruthy();
		expect(panel?.contains(footer as Node)).toBe(true);
		expect(screen.getByRole("button", { name: /^run$/i })).toBeTruthy();
	});
});
