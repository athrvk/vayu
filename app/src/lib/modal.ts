/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Is a modal dialog up?
 *
 * Window-level chords are bound on `window`, so they fire wherever focus is -
 * including inside an open dialog, whose fields are ordinary inputs the send
 * handler's editor exclusions do not cover. That is how `mod+Enter` in the
 * "Save response as example" name field sent the request behind the dialog and
 * `mod+W` closed the tab the dialog belonged to, unmounting its owner
 * mid-interaction (#935).
 *
 * The DOM is the answer rather than a store counter because it is the same
 * answer for every dialog in the app - including ones a future feature adds -
 * with nothing to register, nothing to unregister, and no way for a crashed
 * unmount to leave the count stuck above zero. Every modal here is one
 * `DialogContent`, which stamps `data-slot="dialog-content"`, and Radix mounts
 * it only while open; `data-state` is read too so a dialog still playing its
 * exit animation does not keep the chords inert after it has closed.
 *
 * Non-modal surfaces are deliberately not included: a popover or a dropdown
 * does not take the window, and a chord pressed over one should still act.
 */
export function isModalOpen(): boolean {
	const dialogs = document.querySelectorAll<HTMLElement>('[data-slot="dialog-content"]');
	for (const dialog of dialogs) {
		if (dialog.getAttribute("data-state") !== "closed") return true;
	}
	return false;
}
