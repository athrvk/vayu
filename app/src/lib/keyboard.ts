/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which keystrokes a handler may act on: the Enter that means "do it", told apart from the Enter
 * that means "that's the word I meant" or the Enter that belongs to an app chord, and the targets
 * that own their own keys.
 *
 * An IME (Chinese, Japanese, Korean) commits its composition buffer with Enter, as an ordinary
 * `keydown` the handler cannot tell from a submit, so a field acting on every Enter fires on the
 * first one: saving an example named by a half-composed romaji buffer, fetching a URL still being
 * spelled. `isComposing` is the browser's own answer, true for exactly the keystrokes the IME owns.
 *
 * One definition rather than seven copies, because the guard is invisible when absent: nothing
 * about a plain `e.key === "Enter"` looks wrong.
 */

import type { KeyboardEvent } from "react";

/**
 * True for an Enter that should act: not one committing an IME buffer, and not one carrying
 * Ctrl/Cmd. The modifier half is the same idea one level up (#935): `mod+Enter` is the app's Send
 * chord, so an Enter wearing it was never addressed to the field it landed in; without the check,
 * `mod+Enter` in a dialog's name field runs the field's own action. The send behind the dialog is
 * held off separately, by the Send handler's `isModalOpen()` guard (`RequestBuilderLayout`). Shift
 * is left alone: no field here reads it, and the tree's row-menu binding matches on its own.
 */
export function isCommitEnter(e: KeyboardEvent): boolean {
	return e.key === "Enter" && !e.nativeEvent.isComposing && !e.ctrlKey && !e.metaKey;
}

/**
 * True for a target that owns Enter for its own purposes: the editors where Enter means "newline"
 * (a textarea, a contenteditable, Monaco). A plain `<input>` is deliberately absent: the URL bar is
 * an input, and Send from the URL bar is the chord's most common use.
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
 * The above, plus a plain input: anywhere typing is the point. The collection tree needs this wider
 * set, because it binds bare letters for typeahead and bare Enter for activate, and a rename field
 * inside a row must keep both. It reads from the same definition as `ownsEnterKey` rather than a
 * list of its own: a list of its own covered INPUT and TEXTAREA and missed contenteditable and
 * Monaco (#931).
 */
export function isTextEntryTarget(el: HTMLElement): boolean {
	return el.tagName === "INPUT" || ownsEnterKey(el);
}
