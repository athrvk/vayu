/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Platform detection for renderer-side UI (keyboard hints, etc.).
 *
 * Prefers the Electron main process's reported platform; falls back to the
 * browser's user-agent when running outside Electron (dev in a browser).
 */

function detectMac(): boolean {
	if (typeof window !== "undefined" && window.electronAPI?.platform) {
		return window.electronAPI.platform === "darwin";
	}
	if (typeof navigator !== "undefined") {
		const uaPlatform =
			(navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
				?.platform ||
			navigator.platform ||
			navigator.userAgent;
		return /mac/i.test(uaPlatform);
	}
	return false;
}

export const isMac: boolean = detectMac();

/** Primary modifier key glyph/label for the current platform (⌘ on macOS). */
export const modKey: string = isMac ? "⌘" : "Ctrl";

/**
 * How a chord wants the primary modifier.
 *
 * `true` is lenient - either ⌘ or Ctrl satisfies it, which is what almost every
 * chord wants: one definition that reads ⌘S on a Mac and Ctrl+S elsewhere, and
 * fires for whichever key that platform's users actually press.
 *
 * `"strict"` demands the platform's own modifier and refuses the other one:
 * ⌘ *without* Ctrl on macOS, Ctrl *without* ⌘ elsewhere. Exactly one chord
 * needs it - the palette's ⌘K, because Ctrl+K on macOS is the Cocoa
 * kill-to-end-of-line every text field implements (and Monaco's
 * `deleteAllRight`). A lenient ⌘K listening on the capture phase stole it from
 * the focused control before the control ever saw it.
 */
export type ChordMod = boolean | "strict";

export interface Chord {
	/** Primary modifier - ⌘ on macOS, Ctrl elsewhere. */
	mod?: ChordMod;
	shift?: boolean;
	alt?: boolean;
	/** The final key, e.g. "E", "," or "↵". Always what is *displayed*. */
	key: string;
	/**
	 * What pressing this does, as a surface listing shortcuts would name it -
	 * "Send request", "Close tab".
	 *
	 * On the definition rather than in a table beside it, for the reason the
	 * registry exists at all: a parallel list of names keyed by chord is a
	 * second place a chord is written down, and it goes stale the first time one
	 * is added. Optional on the type because a chord can be declared for a
	 * binding nothing lists (an editor's own); every chord in
	 * `constants/shortcuts.ts` carries one, and a test holds that.
	 */
	label?: string;
	/**
	 * Physical key (`KeyboardEvent.code`, e.g. "Digit1") to match on instead of
	 * `key`, for chords whose character moves with the layout.
	 *
	 * The digit row is the case: on AZERTY the unshifted top row produces
	 * `&é"'(-è_çà`, so `e.key === "1"` never arrives without Shift - and the
	 * shifted press that does produce it collides with the shifted chords. The
	 * position is stable where the character is not, which is why VS Code binds
	 * these by code too. `key` stays the label, so the hint still reads ⌘1.
	 */
	code?: string;
}

/**
 * The individual key-caps of a chord, in display order - ["⇧", "⌘", "E"] on
 * macOS, ["Ctrl", "Shift", "E"] elsewhere.
 *
 * Surfaces that render one `<Kbd>` per key (the response pane's empty state)
 * read this; `formatChord` joins it for the single-string surfaces. Both come
 * from the one `Chord`, so no display site spells a modifier itself.
 */
export function chordKeys({ mod, shift, alt, key }: Chord): string[] {
	if (isMac) {
		return [...(alt ? ["⌥"] : []), ...(shift ? ["⇧"] : []), ...(mod ? ["⌘"] : []), key];
	}
	return [...(mod ? ["Ctrl"] : []), ...(shift ? ["Shift"] : []), ...(alt ? ["Alt"] : []), key];
}

/**
 * Format a keyboard chord for display, platform-appropriately. macOS uses tight
 * Apple glyphs in canonical order (⌃⌥⇧⌘key, e.g. "⇧⌘E"); other platforms use
 * `+`-joined words ("Ctrl+Shift+E"). This is the single place shortcut hints are
 * rendered so every surface (Dock, tooltips, empty states) stays consistent.
 */
export function formatChord(chord: Chord): string {
	return chordKeys(chord).join(isMac ? "" : "+");
}
