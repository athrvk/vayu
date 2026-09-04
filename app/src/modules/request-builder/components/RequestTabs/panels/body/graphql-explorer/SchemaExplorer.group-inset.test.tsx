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
 * One left edge in the schema explorer too.
 *
 * #1372 asked whether this pane's group headings were the same defect as the
 * drawer trees' placeholders; #1378 answered it in the running app. They are
 * not - an uppercase eyebrow over a flat group reads as a label, not as a row
 * that escaped its level. What the app did show is that the pane drew three
 * left edges in 185px: rows on a private `4 + depth * INDENT_STEP`, the
 * headings and both stand-in lines on their own `px-2`, and neither of those
 * on the pane's search field above them.
 *
 * So the rule the drawer trees state now holds here: everything that is not a
 * row takes a root row's own inset. Each case asserts equality against the
 * `paddingLeft` a rendered `treeitem` carries rather than naming 8px again -
 * the value may move, but a heading standing where no row would stand is the
 * defect. Restoring any one of the three to `px-2` leaves `style.paddingLeft`
 * empty and fails its case.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { fixtureSchema } from "@/test/graphql-schema-fixture";
import { useExplorerStore } from "@/lib/graphql/explorer-store";
import { SchemaExplorer } from "./SchemaExplorer";
import type { SchemaEntry } from "@/lib/graphql/schema-cache";

const KEY = "group-inset-key";
const schema = fixtureSchema();

/** jsdom has no `IntersectionObserver`, and the growing window reads one. */
class StubObserver {
	observe() {}
	disconnect() {}
}

function renderExplorer(entry: Partial<SchemaEntry> = {}) {
	return render(
		<TooltipProvider>
			<SchemaExplorer
				entry={{ status: "ready", schema, error: null, fetchedAt: Date.now(), ...entry }}
				schemaKey={KEY}
				onInsert={vi.fn()}
			/>
		</TooltipProvider>
	);
}

const search = (term: string) =>
	fireEvent.change(screen.getByLabelText("Search schema"), { target: { value: term } });

/** Where a branch row - the shallowest row the pane draws - actually starts. */
function rootRowPaddingLeft(): string {
	const { unmount } = renderExplorer();
	const padding = (screen.getAllByRole("treeitem")[0] as HTMLElement).style.paddingLeft;
	unmount();
	expect(padding).not.toBe("");
	return padding;
}

beforeEach(() => {
	vi.stubGlobal("IntersectionObserver", StubObserver);
	useExplorerStore.setState({ open: false, byKey: {}, lru: [] });
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("everything the explorer draws that is not a row takes a row's left edge", () => {
	it("starts a group heading where the results under it start", () => {
		const expected = rootRowPaddingLeft();
		renderExplorer();
		search("search");

		const headings = Array.from(document.querySelectorAll<HTMLElement>("[data-tree-group]"));
		// Two branches match "search", so this also pins the second heading -
		// the one a fix that only touched the first would leave behind.
		expect(headings.length).toBeGreaterThan(1);
		for (const heading of headings) expect(heading.style.paddingLeft).toBe(expected);

		// The rows under the headings are the flat, depth-0 result list, so the
		// heading and its results share one edge rather than merely one formula.
		const row = screen.getAllByRole("treeitem")[0] as HTMLElement;
		expect(row.style.paddingLeft).toBe(expected);
	});

	it("starts the no-results line where the results it replaces would start", () => {
		const expected = rootRowPaddingLeft();
		renderExplorer();
		search("nothingmatchesthis");

		const line = screen.getByText(/Nothing matches/);
		expect(screen.queryAllByRole("treeitem")).toHaveLength(0);
		expect(line.style.paddingLeft).toBe(expected);
	});

	it("starts the no-schema line where the tree it replaces would start", () => {
		const expected = rootRowPaddingLeft();
		renderExplorer({ status: "idle", schema: null });

		const line = screen.getByText(/No schema loaded/);
		expect(line.style.paddingLeft).toBe(expected);
	});
});
