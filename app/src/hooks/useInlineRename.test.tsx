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
 * The inline-rename contract, driven through a row that renders the way the
 * real ones do: a focusable row that swaps its label for the field.
 *
 * Every case here is a defect one of the three hand-rolled editors shipped
 * (#1684): a bare Enter that an IME or the Send chord could fire, an Escape
 * whose own blur committed the cancelled name, an empty value saved as a name,
 * and a keyboard close that dropped focus onto `<body>`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, renderHook, act } from "@testing-library/react";
import { useState } from "react";

import { useInlineRename } from "./useInlineRename";

const onCommit = vi.fn();

/** A row shaped like `RequestItem`'s: rename state above, field inside. */
function Row({ initialValue = "Get users" }: { initialValue?: string }) {
	const [renaming, setRenaming] = useState(true);
	const rename = useInlineRename({
		active: renaming,
		initialValue,
		onCommit: (name) => {
			onCommit(name);
			setRenaming(false);
		},
		onCancel: () => setRenaming(false),
		getRowElement: () => document.querySelector<HTMLElement>("[data-row]"),
	});

	return (
		<div data-row tabIndex={-1}>
			{renaming ? <input aria-label="Name" {...rename.inputProps} /> : <span>closed</span>}
		</div>
	);
}

function renderRow(initialValue?: string) {
	const view = render(<Row initialValue={initialValue} />);
	return view.getByLabelText("Name") as HTMLInputElement;
}

beforeEach(() => onCommit.mockReset());

describe("useInlineRename", () => {
	it("opens with the current name and commits it trimmed on Enter", () => {
		const field = renderRow();
		expect(field.value).toBe("Get users");

		fireEvent.change(field, { target: { value: "  List users  " } });
		fireEvent.keyDown(field, { key: "Enter" });

		expect(onCommit).toHaveBeenCalledWith("List users");
	});

	it("does not commit on the Send chord", () => {
		const field = renderRow();
		fireEvent.change(field, { target: { value: "List users" } });

		fireEvent.keyDown(field, { key: "Enter", metaKey: true });
		fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });

		expect(onCommit).not.toHaveBeenCalled();
	});

	it("does not commit the Enter that commits an IME composition", () => {
		const field = renderRow();
		fireEvent.change(field, { target: { value: "リスト" } });

		fireEvent.keyDown(field, { key: "Enter", isComposing: true });

		expect(onCommit).not.toHaveBeenCalled();
	});

	it("commits exactly once when Enter is followed by the blur it causes", () => {
		const field = renderRow();
		fireEvent.change(field, { target: { value: "List users" } });

		fireEvent.keyDown(field, { key: "Enter" });
		fireEvent.blur(field);

		expect(onCommit).toHaveBeenCalledTimes(1);
	});

	it("cancels rather than committing an empty name", () => {
		const field = renderRow();

		fireEvent.change(field, { target: { value: "   " } });
		fireEvent.keyDown(field, { key: "Enter" });

		expect(onCommit).not.toHaveBeenCalled();
		expect(document.querySelector("[data-row] input")).toBeNull();
	});

	it("commits on a blur the user caused", () => {
		const field = renderRow();

		fireEvent.change(field, { target: { value: "List users" } });
		fireEvent.blur(field);

		expect(onCommit).toHaveBeenCalledWith("List users");
	});

	it("returns focus to the row after a keyboard close", () => {
		const field = renderRow();
		field.focus();

		fireEvent.keyDown(field, { key: "Escape" });

		expect(document.activeElement).toBe(document.querySelector("[data-row]"));
	});

	it("leaves focus alone after a blur, which already moved it", () => {
		const field = renderRow();
		field.focus();

		fireEvent.blur(field);

		expect(document.activeElement).not.toBe(document.querySelector("[data-row]"));
	});
});

/**
 * The Escape race, driven directly.
 *
 * A cancel closes the editor by clearing state one layer up, and the field is
 * still mounted until React has rendered that - so the blur the close causes
 * (the row taking focus back, or the field leaving the document) still reaches
 * the handler. Holding `active` true across both calls is exactly that window.
 */
describe("useInlineRename and the blur a keyboard close causes", () => {
	function renderActive() {
		const onCancel = vi.fn();
		const view = renderHook(() =>
			useInlineRename({
				active: true,
				initialValue: "Get users",
				onCommit,
				onCancel,
			})
		);
		return { ...view, onCancel };
	}

	it("does not commit the blur that follows Escape", () => {
		const { result, onCancel } = renderActive();
		act(() => result.current.setValue("List users"));

		act(() => result.current.inputProps.onKeyDown(escape()));
		act(() => result.current.inputProps.onBlur());

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onCommit).not.toHaveBeenCalled();
	});

	it("does not commit a second time on the blur that follows Enter", () => {
		const { result } = renderActive();
		act(() => result.current.setValue("List users"));

		act(() => result.current.inputProps.onKeyDown(enter()));
		act(() => result.current.inputProps.onBlur());

		expect(onCommit).toHaveBeenCalledTimes(1);
	});
});

/** The two synthetic events these cases need, with nothing the hook does not read. */
function keyEvent(key: string): React.KeyboardEvent<HTMLInputElement> {
	return {
		key,
		ctrlKey: false,
		metaKey: false,
		nativeEvent: { isComposing: false } as KeyboardEvent,
		preventDefault: () => {},
		stopPropagation: () => {},
	} as unknown as React.KeyboardEvent<HTMLInputElement>;
}
const enter = () => keyEvent("Enter");
const escape = () => keyEvent("Escape");
