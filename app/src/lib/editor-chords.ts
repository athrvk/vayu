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
import { SEND_CHORD, LOAD_TEST_CHORD } from "@/constants/shortcuts";
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
 * Bind the window chords an editor would otherwise swallow.
 *
 * Only the two Enter chords: everything else in the map is a letter or a digit
 * Monaco does not claim, so it reaches `window` on its own.
 */
export function registerEditorChords(
	editor: Monaco.editor.IStandaloneCodeEditor,
	monaco: MonacoApi
): void {
	for (const chord of [SEND_CHORD, LOAD_TEST_CHORD]) {
		const binding = chordKeybinding(chord, monaco);
		if (binding === null) continue;
		editor.addCommand(binding, () => dispatchChord(chord));
	}
}
