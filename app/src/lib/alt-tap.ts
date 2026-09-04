/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A tap of Alt on its own - pressed and released with nothing in between.
 *
 * Windows and most Linux desktops open the window's menu on that gesture, which
 * is why the title bar's application menu answers it (#1361). It is not a
 * `Chord`: `matchesChord` reads the key that arrives *with* a modifier, and
 * this has no key of its own - Alt is both the modifier and the key, and the
 * gesture is only a menu request if the press ends without one. Alt+Tab, Alt+←
 * (Go back) and a click with Alt held all pass through the same keydown, so the
 * watcher is a two-event state machine rather than a predicate.
 *
 * Cancelling is the half that matters: Alt+Tab moves focus away before the
 * keyup ever arrives, so the window's `blur` disarms it, and a release that
 * lands back in the window later does not open a menu the user did not ask for.
 */
export interface AltTapWatcher {
	keydown(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey">): void;
	keyup(event: Pick<KeyboardEvent, "key">): void;
	/** Focus left, or the pointer took over: the press is no longer a tap. */
	cancel(): void;
}

export function createAltTapWatcher(onTap: () => void): AltTapWatcher {
	let armed = false;

	return {
		keydown(event) {
			// Any other key disarms, which is what makes Alt+Tab and Alt+← not a
			// menu request. AltGr arrives as "AltGraph" (and as Ctrl+Alt on the
			// layouts that synthesise it), so both spellings fail this test.
			armed = event.key === "Alt" && !event.ctrlKey && !event.metaKey && !event.shiftKey;
		},
		keyup(event) {
			const tapped = armed && event.key === "Alt";
			armed = false;
			if (tapped) onTap();
		},
		cancel() {
			armed = false;
		},
	};
}
