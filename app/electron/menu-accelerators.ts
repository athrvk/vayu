/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The accelerators the application menu registers (#3325).
 *
 * The renderer's `constants/shortcuts.ts` is the one list of what the app
 * answers to, and Settings > Keyboard shortcuts draws from it. The menu's
 * accelerators are chords too, but this process cannot import that file (the
 * main-process build is rooted at `electron/`), so the keys are written here
 * as plain shapes and `menu-accelerators.test.ts` compares every one against
 * the real chord. `createMenu` in main.ts takes its accelerator strings from
 * `menuAccelerators` and from nowhere else, which a source scan in the same
 * test holds - so a menu key cannot change without the panel's row changing
 * with it.
 *
 * Kept free of Electron types for the reason `app-menu.ts` gives: main.ts runs
 * its whole startup at import, and nothing here needs it.
 */

/** The slice of the renderer's `Chord` an accelerator is spelled from. */
export interface AcceleratorChord {
	mod?: boolean | "strict";
	shift?: boolean;
	alt?: boolean;
	key: string;
}

/**
 * Keys whose display glyph is not the name Electron's accelerator grammar
 * takes. Everything else - letters, digits, `=`, `-`, `,`, brackets - is
 * written as it is.
 */
const ACCELERATOR_KEY_NAMES: Readonly<Record<string, string>> = {
	"+": "Plus",
	"←": "Left",
	"→": "Right",
	"↑": "Up",
	"↓": "Down",
	"↵": "Return",
};

/**
 * An Electron accelerator for a chord: `mod` is `CmdOrCtrl` (the lenient and the
 * strict spelling both land there - Electron has no weaker form), then Shift,
 * Alt and the key.
 */
export function chordAccelerator({ mod, shift, alt, key }: AcceleratorChord): string {
	return [
		...(mod ? ["CmdOrCtrl"] : []),
		...(shift ? ["Shift"] : []),
		...(alt ? ["Alt"] : []),
		ACCELERATOR_KEY_NAMES[key] ?? key,
	].join("+");
}

/** What `createMenu` binds, by the menu item that carries it. */
export interface MenuAccelerators {
	back: string;
	forward: string;
	actualSize: string;
	zoomIn: string;
	/**
	 * The hidden twin of Zoom In. The role this replaced also answered to
	 * Cmd/Ctrl+Plus, the shifted key on most layouts, and one menu item holds
	 * one accelerator.
	 */
	zoomInPlus: string;
	zoomOut: string;
	closeWindow: string;
	quit: string;
	/** macOS only: Windows and Linux leave Settings to the renderer's own chord. */
	preferences: string;
}

/**
 * The menu's accelerators for a platform (`process.platform`).
 *
 * Back and forward are the one pair that differs: ⌘[ / ⌘] on macOS, Alt+Left /
 * Alt+Right elsewhere, the same split `GO_BACK_CHORD` makes in the renderer.
 *
 * `preferences` is read on macOS only. On Windows and Linux the Settings item
 * carries no accelerator: the renderer binds its chord on `window`, and a menu
 * accelerator on the same key would take the keydown before the page sees it
 * while printing "Ctrl+Comma" beside the item.
 */
export function menuAccelerators(platform: string): MenuAccelerators {
	const mac = platform === "darwin";
	return {
		back: chordAccelerator(mac ? { mod: true, key: "[" } : { alt: true, key: "←" }),
		forward: chordAccelerator(mac ? { mod: true, key: "]" } : { alt: true, key: "→" }),
		actualSize: chordAccelerator({ mod: true, key: "0" }),
		zoomIn: chordAccelerator({ mod: true, key: "=" }),
		zoomInPlus: chordAccelerator({ mod: true, key: "+" }),
		zoomOut: chordAccelerator({ mod: true, key: "-" }),
		closeWindow: chordAccelerator({ mod: true, shift: true, key: "W" }),
		quit: chordAccelerator({ mod: true, key: "Q" }),
		preferences: chordAccelerator({ mod: true, key: "," }),
	};
}
