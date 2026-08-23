/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which keystrokes a handler may act on: the Enter that means "do it", told
 * apart from the Enter that means "that's the word I meant" or the Enter that
 * belongs to an app chord, and the targets that own their own keys.
 *
 * An IME (Chinese, Japanese, Korean) commits its composition buffer with
 * Enter, and that commit arrives as an ordinary `keydown` the handler cannot
 * distinguish from a submit. A field that acts on every Enter therefore fires
 * on the first one - saving an example named by a half-composed romaji buffer,
 * fetching a URL that is still being spelled. `isComposing` is the browser's
 * own answer: it is true for exactly the keystrokes the IME owns.
 *
 * It lives here as one definition rather than seven copies because the guard
 * is invisible when absent - nothing about a plain `e.key === "Enter"` looks
 * wrong, which is how all seven sites came to be missing it at once.
 */

import type { KeyboardEvent } from "react";

/**
 * True for an Enter that should act - not one committing an IME buffer, and
 * not one carrying Ctrl/Cmd.
 *
 * The modifier half is the same idea one level up (#935): `mod+Enter` is the
 * app's Send chord, so an Enter wearing it was never addressed to the field it
 * happened to land in. Without the check, `mod+Enter` in a dialog's name field
 * ran the field's own action *and* - before the modal guard below - the send
 * behind the dialog, which is two actions from one press. Shift is left alone:
 * no field here reads it, and the tree's row-menu binding matches on its own.
 */
export function isCommitEnter(e: KeyboardEvent): boolean {
	return e.key === "Enter" && !e.nativeEvent.isComposing && !e.ctrlKey && !e.metaKey;
}

/**
 * True for a target that owns Enter for its own purposes.
 *
 * A plain `<input>` is deliberately absent: the URL bar is an input, and Send
 * from the URL bar is the chord's most common use. What is here is the set of
 * editors where Enter means "newline" - a textarea, a contenteditable, Monaco.
 */
export function ownsEnterKey(el: HTMLElement): boolean {
	return (
		el.tagName === "TEXTAREA" ||
		el.isContentEditable ||
		el.closest('[contenteditable="true"]') !== null ||
		// Monaco editor creates elements with class 'monaco-editor'
		el.closest(".monaco-editor") !== null
	);
}

/**
 * The above, plus a plain input: anywhere typing is the point.
 *
 * The collection tree needs this wider set, because it binds bare letters for
 * typeahead and bare Enter for activate - a rename field inside a row must
 * keep both. It reads from the same definition as `ownsEnterKey` rather than
 * from its own list, which is how the tree came to cover INPUT and TEXTAREA
 * while missing contenteditable and Monaco (#931).
 */
export function isTextEntryTarget(el: HTMLElement): boolean {
	return el.tagName === "INPUT" || ownsEnterKey(el);
}
