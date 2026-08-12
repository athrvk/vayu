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

import type { Chord } from "@/lib/platform";

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
 */
export const PALETTE_CHORD: Chord = { mod: true, key: "K" };

/**
 * Does this event match a chord?
 *
 * `shift` is compared strictly rather than ignored: without that,
 * Ctrl+Shift+Enter satisfies Send's `mod + Enter` too and both fire, which is
 * the one thing a modifier-distinguished pair must not do.
 *
 * The key itself is compared case-insensitively, because a letter chord is
 * declared in the case it is *displayed* in ("K", so the hint reads ⌘K) while
 * `KeyboardEvent.key` reports the character the keyboard produced - "k"
 * unmodified, "K" under Caps Lock. Case is never what distinguishes two chords
 * here; `shift` is, and it is still compared exactly.
 */
export function matchesChord(
	e: Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "metaKey" | "ctrlKey">,
	chord: Chord
): boolean {
	const key = chord.key === "↵" ? "Enter" : chord.key;
	if (e.key.toLowerCase() !== key.toLowerCase()) return false;
	if (!!chord.mod !== (e.metaKey || e.ctrlKey)) return false;
	if (!!chord.shift !== e.shiftKey) return false;
	if (!!chord.alt !== e.altKey) return false;
	return true;
}
