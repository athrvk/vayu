/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @vitest-environment jsdom
 */

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useRef } from "react";
import { useHistoryListFocus } from "./useHistoryListFocus";

/**
 * Three row activators, the real shape `RunItem` renders: a `<button>` with
 * `data-history-activate` and `tabIndex={-1}`, promoted by the hook rather
 * than seeded in markup - the same contract `RunItem.tsx`'s own comment
 * documents.
 */
function List() {
	const ref = useRef<HTMLDivElement>(null);
	const { onKeyDown, onFocus } = useHistoryListFocus(ref);
	return (
		// eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- fixture for the same role="group" roving-tabindex shape HistoryList.tsx uses
		<div ref={ref} role="group" onKeyDown={onKeyDown} onFocus={onFocus}>
			<button data-history-activate tabIndex={-1}>
				run one
			</button>
			<input placeholder="Search runs by api..." />
			<button data-history-activate tabIndex={-1}>
				run two
			</button>
			<button data-history-activate tabIndex={-1}>
				run three
			</button>
		</div>
	);
}

function row(name: string) {
	return screen.getByRole("button", { name });
}

describe("useHistoryListFocus", () => {
	it("seeds exactly one row as the tab stop on mount", () => {
		render(<List />);
		expect(row("run one")).toHaveAttribute("tabIndex", "0");
		expect(row("run two")).toHaveAttribute("tabIndex", "-1");
		expect(row("run three")).toHaveAttribute("tabIndex", "-1");
	});

	it("moves focus down and up without opening anything", () => {
		render(<List />);
		row("run one").focus();

		fireEvent.keyDown(row("run one"), { key: "ArrowDown" });
		expect(row("run two")).toHaveFocus();
		expect(row("run two")).toHaveAttribute("tabIndex", "0");
		expect(row("run one")).toHaveAttribute("tabIndex", "-1");

		fireEvent.keyDown(row("run two"), { key: "ArrowUp" });
		expect(row("run one")).toHaveFocus();
	});

	it("does not move past either end", () => {
		render(<List />);
		row("run one").focus();
		fireEvent.keyDown(row("run one"), { key: "ArrowUp" });
		expect(row("run one")).toHaveFocus();

		row("run three").focus();
		fireEvent.keyDown(row("run three"), { key: "ArrowDown" });
		expect(row("run three")).toHaveFocus();
	});

	it("jumps to the first and last row on Home/End", () => {
		render(<List />);
		row("run two").focus();

		fireEvent.keyDown(row("run two"), { key: "End" });
		expect(row("run three")).toHaveFocus();

		fireEvent.keyDown(row("run three"), { key: "Home" });
		expect(row("run one")).toHaveFocus();
	});

	it("leaves the search box alone - arrow keys there are for text editing", () => {
		render(<List />);
		const search = screen.getByPlaceholderText("Search runs by api...");
		search.focus();

		fireEvent.keyDown(search, { key: "ArrowDown" });
		expect(search).toHaveFocus();
	});

	it("lets a chord pass through untouched", () => {
		render(<List />);
		row("run one").focus();

		fireEvent.keyDown(row("run one"), { key: "ArrowDown", metaKey: true });
		expect(row("run one")).toHaveFocus();
	});

	it("promotes a clicked row to the tab stop, so Tab returns to it", () => {
		render(<List />);
		fireEvent.focus(row("run three"));

		expect(row("run three")).toHaveAttribute("tabIndex", "0");
		expect(row("run one")).toHaveAttribute("tabIndex", "-1");
	});
});
