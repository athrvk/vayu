/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The app's window chords, inside a Monaco editor.
 *
 * Monaco consumes the keys it recognises before they reach `window`, and Send
 * is one of them: `ownsEnterKey` deliberately excludes editors from the window
 * handler (a code editor owns Enter), so ⌘↵ inserted a newline in the body,
 * GraphQL and script editors - the panes the palette's own comment calls where
 * users spend "most of the time" (#938).
 *
 * The bridge is a re-dispatch rather than a second call site for `executeRequest`:
 * the editor says "this chord was pressed", on `document.body` so that no
 * editor-owns-Enter guard sees it, and the one window handler still decides.
 * That keeps every gate it holds - a run already in flight, an empty URL, an
 * open modal, a layout with no load test available - in the single place they
 * are written, instead of copying four conditions into the editor wrapper.
 */

import type * as Monaco from "monaco-editor";
import type { MonacoApi } from "./monaco-api";
import {
	SEND_CHORD,
	LOAD_TEST_CHORD,
	TOGGLE_CONTEXT_BAR_CHORD,
	LEAVE_EDITOR_CHORD,
} from "@/constants/shortcuts";
import { isMac, type Chord } from "@/lib/platform";

/**
 * A chord as a Monaco keybinding number (`KeyMod.CtrlCmd | KeyCode.Enter`), or
 * `null` for a key this bridge has no `KeyCode` for.
 *
 * Null rather than a guess: a wrong `KeyCode` binds a chord the user never
 * asked for and looks like it worked, which is the failure mode this whole
 * issue is about.
 */
export function chordKeybinding(chord: Chord, monaco: MonacoApi): number | null {
	const code = keyCodeFor(chord.key, monaco);
	if (code === null) return null;
	let binding = 0;
	// `CtrlCmd` is Monaco's own name for the lenient primary modifier: ⌘ on
	// macOS, Ctrl elsewhere, which is exactly what `mod` means here.
	if (chord.mod) binding |= monaco.KeyMod.CtrlCmd;
	if (chord.shift) binding |= monaco.KeyMod.Shift;
	if (chord.alt) binding |= monaco.KeyMod.Alt;
	return binding | code;
}

function keyCodeFor(key: string, monaco: MonacoApi): number | null {
	if (key === "↵") return monaco.KeyCode.Enter;
	if (/^[A-Za-z]$/.test(key)) return monaco.KeyCode.KeyA + (key.toUpperCase().charCodeAt(0) - 65);
	if (/^[1-9]$/.test(key)) return monaco.KeyCode.Digit1 + (key.charCodeAt(0) - 49);
	return null;
}

/** Re-dispatch a chord as a real keydown, for the window handlers to match. */
export function dispatchChord(chord: Chord): void {
	document.body.dispatchEvent(
		new KeyboardEvent("keydown", {
			key: chord.key === "↵" ? "Enter" : chord.key,
			code: chord.code ?? "",
			metaKey: isMac ? !!chord.mod : false,
			ctrlKey: isMac ? false : !!chord.mod,
			shiftKey: !!chord.shift,
			altKey: !!chord.alt,
			bubbles: true,
		})
	);
}

/**
 * The window chords an editor would otherwise swallow.
 *
 * Enter for the two send chords, because Monaco owns Enter and `ownsEnterKey`
 * excludes editors from the window handler on purpose (#938).
 *
 * ⌘I for the opposite reason, and it is the correction of what this comment
 * used to claim - that "everything else in the map is a letter or a digit
 * Monaco does not claim". I is claimed: the standalone editor binds CtrlCmd+I
 * as a secondary keybinding for `triggerSuggest` on every platform, and its
 * keybinding service calls `preventDefault` *and* `stopPropagation` for any
 * binding it resolves, so the context-bar toggle died at the editor instead of
 * reaching `Shell`'s bubble-phase listener. S, W, B, comma, the digits and the
 * ⇧ view chords really are unbound there and still arrive on their own.
 */
const BRIDGED_CHORDS: readonly Chord[] = [SEND_CHORD, LOAD_TEST_CHORD, TOGGLE_CONTEXT_BAR_CHORD];

/**
 * What a Tab press can land on, as the browser decides it.
 *
 * `tabindex="-1"` is excluded rather than included: those nodes are focusable
 * by script only, so landing on one puts the user where Tab did not offer to
 * go and where the next Tab continues from somewhere they cannot see.
 */
const FOCUSABLE_SELECTOR = [
	"a[href]",
	"button:not([disabled])",
	"input:not([disabled])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	'[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Move focus to the first focusable element after `container`, or - when the
 * editor is the last thing on the page - back to the nearest one before it.
 *
 * This is the editor's way out, so the target has to be somewhere Tab would
 * have gone. Focusing the container itself is not: Monaco's textarea is *inside*
 * it, so the next Tab would walk straight back in.
 *
 * Whether a candidate is visible is read back from `document.activeElement`
 * rather than decided in advance. A `display: none` element ignores `.focus()`,
 * so the read is exact where a geometric test would be a guess - and it is the
 * one check jsdom, which has no layout and reports every element as zero-sized,
 * can still answer honestly.
 *
 * Document order, not the tab order proper: a positive `tabIndex` would come
 * first in a real Tab press and does not here. Nothing in `app/src` uses one,
 * and the day something does, this is the line to revisit.
 *
 * Returns whether focus moved. Nothing acts on `false` - when an editor is the
 * only focusable thing on the page there is no better place to send focus than
 * where it already is - so the reader is `editor-chords.test.ts`, which is what
 * makes "nowhere to go" a case rather than an assumption.
 */
export function focusAfterEditor(container: HTMLElement | null | undefined): boolean {
	if (!container) return false;

	const outside = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
		(el) => !container.contains(el) && !el.closest("[aria-hidden='true'],[inert],[hidden]")
	);
	const firstAfter = outside.findIndex(
		(el) => (container.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
	);
	// Everything after the editor in document order, then everything before it
	// walked backwards - Tab's order, then Shift+Tab's when Tab has run out.
	const order =
		firstAfter === -1
			? [...outside].reverse()
			: [...outside.slice(firstAfter), ...outside.slice(0, firstAfter).reverse()];

	for (const el of order) {
		el.focus();
		if (document.activeElement === el) return true;
	}
	return false;
}

/**
 * Bind, on one editor instance, the chords the app owns inside Monaco: the
 * window chords above, re-dispatched, and the exit from the Tab trap, which is
 * the one chord that acts here rather than at `window` - there is no window
 * handler for "leave *this* editor", and a re-dispatch would have nothing to
 * tell one which editor it was.
 */
export function registerEditorChords(
	editor: Monaco.editor.IStandaloneCodeEditor,
	monaco: MonacoApi
): void {
	for (const chord of BRIDGED_CHORDS) {
		const binding = chordKeybinding(chord, monaco);
		if (binding === null) continue;
		editor.addCommand(binding, () => dispatchChord(chord));
	}

	const leave = chordKeybinding(LEAVE_EDITOR_CHORD, monaco);
	if (leave !== null) {
		editor.addCommand(leave, () => focusAfterEditor(editor.getContainerDomNode()));
	}
}
