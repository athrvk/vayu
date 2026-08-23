/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * App-wide keyboard shortcuts, in one place.
 *
 * Each is defined once as a `Chord` and read by both the handler that fires it
 * and the label that advertises it, so a button cannot claim a key combination
 * the handler does not listen for. Send had worked since forever and appeared
 * nowhere on screen; Load Test had no shortcut at all.
 *
 * `formatChord` renders them per platform (⌘↵ on macOS, Ctrl+↵ elsewhere) - see
 * `lib/platform.ts`.
 */

import { isMac, type Chord } from "@/lib/platform";
import type { DrawerView } from "@/stores";

/** Send the request. */
export const SEND_CHORD: Chord = { mod: true, key: "↵" };

/** Start a load test. Shift distinguishes it from Send, as it escalates it. */
export const LOAD_TEST_CHORD: Chord = { mod: true, shift: true, key: "↵" };

/**
 * Open the command palette.
 *
 * ⌘K/Ctrl+K is the cross-app convention for "search everything" (VS Code,
 * Slack, Linear, GitHub), which is the whole reason it is worth taking: the
 * chord is the one users already try.
 *
 * Declared here rather than inline in `Shell` because a second surface reads
 * it - the palette's own hint, and the title-bar search bar that will show the
 * chord it triggers. That is exactly the pairing this file exists to keep
 * honest.
 *
 * `mod: "strict"` is the one exception to the lenient modifier, and it is not a
 * preference: this listener runs on the *capture* phase (see `CommandPalette`),
 * so a lenient match ate Ctrl+K on macOS - the Cocoa kill-to-end-of-line - out
 * of every input and editor in the app before the focused control saw it.
 */
export const PALETTE_CHORD: Chord = { mod: "strict", key: "K" };

/** Save the active tab's entity. */
export const SAVE_CHORD: Chord = { mod: true, key: "S" };

/** Close the active tab. */
export const CLOSE_TAB_CHORD: Chord = { mod: true, key: "W" };

/** Show/hide the left drawer. */
export const TOGGLE_DRAWER_CHORD: Chord = { mod: true, key: "B" };

/** Show/hide the right context bar. */
export const TOGGLE_CONTEXT_BAR_CHORD: Chord = { mod: true, key: "I" };

/** Open Settings, the platform convention for a preferences window. */
export const SETTINGS_CHORD: Chord = { mod: true, key: "," };

/**
 * The drawer view switchers, keyed by the view they activate.
 *
 * ⌘S is Save, so Services takes the shifted pair - free in both maps: the
 * renderer binds no other ⇧⌘ chord and the native menu's only one is ⇧⌘W
 * (close window). Settings is the odd one out because ⌘, is the platform
 * convention and predates the drawer having a Settings view at all.
 *
 * Read by the Shell's handler and by the Dock's tooltips, which is the pairing
 * this file exists for: the Dock advertised these as six independent
 * `formatChord` literals, coupled to the handler by a comment.
 */
export const DRAWER_VIEW_CHORDS: Record<DrawerView, Chord> = {
	collections: { mod: true, shift: true, key: "E" },
	history: { mod: true, shift: true, key: "H" },
	variables: { mod: true, shift: true, key: "U" },
	services: { mod: true, shift: true, key: "S" },
	settings: SETTINGS_CHORD,
};

/**
 * ⌘1-⌘9, focusing the nth open tab.
 *
 * Bound by `code` rather than by character - see `Chord.code`. The index into
 * this array is the tab index, so the order is the definition.
 */
export const TAB_CHORDS: readonly Chord[] = Array.from({ length: 9 }, (_, i) => ({
	mod: true,
	key: String(i + 1),
	code: `Digit${i + 1}`,
}));

/**
 * Does this event match a chord?
 *
 * `shift` is compared strictly rather than ignored: without that,
 * Ctrl+Shift+Enter satisfies Send's `mod + Enter` too and both fire, which is
 * the one thing a modifier-distinguished pair must not do.
 *
 * `alt` is compared the same way, and that is a bug fix rather than symmetry:
 * on many European Windows layouts AltGr *is* Ctrl+Alt, so a handler that
 * ignored `altKey` fired Save on AltGr+S and closed the tab on AltGr+W while
 * the user was typing a `@`, `€` or `\`.
 *
 * The key itself is compared case-insensitively, because a letter chord is
 * declared in the case it is *displayed* in ("K", so the hint reads ⌘K) while
 * `KeyboardEvent.key` reports the character the keyboard produced - "k"
 * unmodified, "K" under Caps Lock. Case is never what distinguishes two chords
 * here; `shift` is, and it is still compared exactly. A chord carrying a `code`
 * is matched on that instead, the character it produces being irrelevant.
 */
export function matchesChord(
	e: Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "altKey" | "metaKey" | "ctrlKey">,
	chord: Chord
): boolean {
	if (chord.code) {
		if (e.code !== chord.code) return false;
	} else {
		const key = chord.key === "↵" ? "Enter" : chord.key;
		if (e.key.toLowerCase() !== key.toLowerCase()) return false;
	}
	if (chord.mod === "strict") {
		if (isMac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return false;
	} else if (!!chord.mod !== (e.metaKey || e.ctrlKey)) return false;
	if (!!chord.shift !== e.shiftKey) return false;
	if (!!chord.alt !== e.altKey) return false;
	return true;
}
