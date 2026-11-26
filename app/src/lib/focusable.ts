/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a Tab press can land on, and how to hand focus to one of them. The one answer to "what is
 * focusable" for the Monaco Tab-trap exit (`lib/editor-chords.ts`, #1213) and the region chords
 * (#1219): a second `querySelectorAll("a[href],button,…")` would drift the first time one of them
 * learned a new element type.
 */

/**
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
 * Every focusable element inside `root`, in document order, minus those in a subtree the browser
 * hides from assistive technology or from interaction entirely.
 */
export function focusableWithin(root: ParentNode): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
		(el) => !el.closest("[aria-hidden='true'],[inert],[hidden]")
	);
}

/**
 * Focus the first candidate that will actually take focus, in the order given, and return whether
 * focus moved, so a caller with somewhere else to try can. Visibility is read back from
 * `document.activeElement`, not decided in advance: a `display: none` element ignores `.focus()`,
 * so the read is exact where a geometric test would guess, and it is the one check jsdom (no
 * layout, every element zero-sized) still answers honestly.
 */
export function focusFirstOf(candidates: readonly HTMLElement[]): boolean {
	for (const el of candidates) {
		el.focus();
		if (document.activeElement === el) return true;
	}
	return false;
}
