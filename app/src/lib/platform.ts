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

export interface Chord {
	/** Primary modifier — ⌘ on macOS, Ctrl elsewhere. */
	mod?: boolean;
	shift?: boolean;
	alt?: boolean;
	/** The final key, e.g. "E", "," or "↵". */
	key: string;
}

/**
 * Format a keyboard chord for display, platform-appropriately. macOS uses tight
 * Apple glyphs in canonical order (⌃⌥⇧⌘key, e.g. "⇧⌘E"); other platforms use
 * `+`-joined words ("Ctrl+Shift+E"). This is the single place shortcut hints are
 * rendered so every surface (Dock, tooltips, empty states) stays consistent.
 */
export function formatChord({ mod, shift, alt, key }: Chord): string {
	if (isMac) {
		return `${alt ? "⌥" : ""}${shift ? "⇧" : ""}${mod ? "⌘" : ""}${key}`;
	}
	const parts: string[] = [];
	if (mod) parts.push("Ctrl");
	if (shift) parts.push("Shift");
	if (alt) parts.push("Alt");
	parts.push(key);
	return parts.join("+");
}
