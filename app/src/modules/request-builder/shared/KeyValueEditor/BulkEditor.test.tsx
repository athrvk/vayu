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
 * The table/text toggle, which used to exist twice.
 *
 * `ParamsPanel` and `HeadersPanel` each carried the same `isBulkEditMode` and
 * `bulkEditText` state, the same toggle handler with the same "save on the way
 * out, load on the way in" comment, the same toolbar row and the same textarea -
 * both labelled `id="bulk-edit"`, which is only harmless because one panel is
 * mounted at a time.
 *
 * The behaviour worth pinning is the *staging* one. Bulk edit is a scratch pad:
 * the draft is local, and it commits when you switch back to the table. Parsing
 * on every keystroke would rewrite the request underneath a half-finished
 * paste - which is why `onCommit` fires on the toggle and nowhere else.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BulkEditor } from "./BulkEditor";

function setup(format = () => "a: 1\nb: 2") {
	const onCommit = vi.fn();
	render(
		<BulkEditor
			label="Headers"
			format={format}
			onCommit={onCommit}
			placeholder="Name: value"
			hint={<>Format: Name: value</>}
			tableHeader={<span>empty hint</span>}
		>
			<div data-testid="table">the table</div>
		</BulkEditor>
	);
	return { onCommit };
}

const textarea = () => screen.queryByRole("textbox");
const toggle = () => screen.getByRole("button");

describe("switching between the table and the text", () => {
	it("starts on the table", () => {
		setup();
		expect(screen.getByTestId("table")).toBeInTheDocument();
		expect(textarea()).not.toBeInTheDocument();
	});

	it("loads the current rows as text when switching in", () => {
		setup();
		fireEvent.click(toggle());
		expect((textarea() as HTMLTextAreaElement).value).toBe("a: 1\nb: 2");
		expect(screen.queryByTestId("table")).not.toBeInTheDocument();
	});

	it("commits the draft only when switching back", () => {
		// The staging property. Typing must not rewrite the request.
		const { onCommit } = setup();
		fireEvent.click(toggle());
		fireEvent.change(textarea()!, { target: { value: "c: 3" } });
		expect(onCommit).not.toHaveBeenCalled();

		fireEvent.click(toggle());
		expect(onCommit).toHaveBeenCalledExactlyOnceWith("c: 3");
		expect(screen.getByTestId("table")).toBeInTheDocument();
	});

	it("re-reads the rows every time it opens, not once", () => {
		// A stale draft would silently revert whatever the table did in between.
		let rows = "a: 1";
		setup(() => rows);
		fireEvent.click(toggle());
		expect((textarea() as HTMLTextAreaElement).value).toBe("a: 1");
		fireEvent.click(toggle());

		rows = "a: 1\nb: 2";
		fireEvent.click(toggle());
		expect((textarea() as HTMLTextAreaElement).value).toBe("a: 1\nb: 2");
	});
});

describe("the label and the field agree", () => {
	it("gives the textarea an id derived from the label", () => {
		// Both old copies hardcoded `id="bulk-edit"`, so two of these on one
		// screen would have pointed one label at the other's field.
		setup();
		fireEvent.click(toggle());
		expect(textarea()).toHaveAttribute("id", "bulk-edit-headers");
		expect(screen.getByText("Headers")).toHaveAttribute("for", "bulk-edit-headers");
	});
});

describe("the header slot", () => {
	it("shows the caller's hint beside the table", () => {
		setup();
		expect(screen.getByText("empty hint")).toBeInTheDocument();
	});

	it("hides it in text mode, where it does not apply", () => {
		setup();
		fireEvent.click(toggle());
		expect(screen.queryByText("empty hint")).not.toBeInTheDocument();
	});
});
