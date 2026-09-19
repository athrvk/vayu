/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One inline rename editor for every tree that has one.
 *
 * The app had three, with three commit models: the collections tree committed
 * on a bare `e.key === "Enter"`, `ElementList` used `isCommitEnter` and trimmed
 * in its own commit, and the variables tree kept a third branch. Three copies
 * of one keyboard contract is three chances to miss a case, and each had missed
 * a different one (issue #1684).
 *
 * The contract this owns:
 *
 * - **Enter commits only through `isCommitEnter`** (#939, #935). An IME commits
 *   its composition buffer with Enter and that arrives as an ordinary keydown,
 *   so a bare check renames a row to a half-composed buffer; and `mod+Enter` is
 *   the app's Send chord, so a field acting on it renamed the request *and*
 *   sent it from one press.
 * - **Escape never commits.** Both tree renames called cancel on Escape and
 *   commit on blur, and cancelling unmounts the field - so the blur Escape
 *   itself causes raced the cancel and could save the name the user had just
 *   abandoned. `closedRef` closes the editor once: the blur that follows a
 *   keyboard close is the one that close caused, and it does nothing.
 * - **An empty name cancels, it never commits.** A blank rename is an
 *   abandoned one, not a request to erase the name - except where the name is
 *   itself optional and blanking it restores a default label, which is
 *   `commitEmpty` and `ElementList`'s one caller.
 * - **Focus returns to the row on a keyboard close, never on a blur.** The
 *   trees are one tab stop each and the field replaces the row's only focusable
 *   control, so F2 then Escape used to drop the user out of the tree onto
 *   `<body>`. A blur means focus has already gone where the user put it.
 *   The refocus waits for the row to stop renaming rather than running inline:
 *   focusing the row while the field is still mounted *blurs* the field, and
 *   that blur commits.
 */

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";

import { isCommitEnter } from "@/lib/keyboard";

export interface UseInlineRenameOptions {
	/** True while this row's rename field is mounted. */
	active: boolean;
	/** The name the field opens with; read once, when `active` turns true. */
	initialValue: string;
	/** Called with the trimmed, non-empty name. */
	onCommit: (name: string) => void;
	/** Called for Escape, and for a commit whose value trimmed to nothing. */
	onCancel: () => void;
	/**
	 * The row element focus goes back to after a keyboard close. Called while
	 * the field is still mounted (so a caller can look the row up by a data
	 * attribute, as the variables tree does) and the element is held until the
	 * field has unmounted.
	 */
	getRowElement?: () => HTMLElement | null | undefined;
	/**
	 * Commit an empty value instead of cancelling. Only for a field whose entity
	 * has an optional name: `ElementList`'s row shows the kind label when the
	 * name is blank, so clearing it is an action, not an abandoned edit.
	 */
	commitEmpty?: boolean;
	/**
	 * Stop the keydown reaching an ancestor. The variables tree binds keys on
	 * the `role="tree"` element above the field and needs it.
	 */
	stopPropagation?: boolean;
}

export interface InlineRename {
	value: string;
	setValue: (value: string) => void;
	/** Spread onto the rename `<Input>`; the caller keeps `autoFocus` and styling. */
	inputProps: {
		value: string;
		onChange: (e: ChangeEvent<HTMLInputElement>) => void;
		onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
		onBlur: () => void;
	};
}

export function useInlineRename({
	active,
	initialValue,
	onCommit,
	onCancel,
	getRowElement,
	commitEmpty = false,
	stopPropagation = false,
}: UseInlineRenameOptions): InlineRename {
	const [value, setValue] = useState(initialValue);
	/** Set the moment the editor closes, so the blur that close causes is a no-op. */
	const closedRef = useRef(false);
	const wasActiveRef = useRef(active);
	const focusTargetRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		if (active && !wasActiveRef.current) {
			// A fresh open, not a re-render: `initialValue` is read here and
			// nowhere else, so a rename that lands and changes the row's name
			// cannot reach back into a draft the user is still typing.
			setValue(initialValue);
			closedRef.current = false;
			focusTargetRef.current = null;
		}
		wasActiveRef.current = active;

		if (!active && focusTargetRef.current) {
			const row = focusTargetRef.current;
			focusTargetRef.current = null;
			row.focus();
		}
	}, [active, initialValue]);

	const close = (fromKeyboard: boolean) => {
		closedRef.current = true;
		if (fromKeyboard) focusTargetRef.current = getRowElement?.() ?? null;
	};

	const commit = (fromKeyboard: boolean) => {
		if (closedRef.current) return;
		const trimmed = value.trim();
		close(fromKeyboard);
		if (!trimmed && !commitEmpty) {
			onCancel();
			return;
		}
		onCommit(trimmed);
	};

	const cancel = (fromKeyboard: boolean) => {
		if (closedRef.current) return;
		close(fromKeyboard);
		onCancel();
	};

	return {
		value,
		setValue,
		inputProps: {
			value,
			onChange: (e) => setValue(e.target.value),
			onKeyDown: (e) => {
				if (stopPropagation) e.stopPropagation();
				if (isCommitEnter(e)) {
					e.preventDefault();
					commit(true);
				} else if (e.key === "Escape") {
					e.preventDefault();
					cancel(true);
				}
			},
			onBlur: () => commit(false),
		},
	};
}
