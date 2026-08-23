/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Enter that means "do it", told apart from the Enter that means
 * "that's the word I meant".
 *
 * An IME (Chinese, Japanese, Korean) commits its composition buffer with
 * Enter, and that commit arrives as an ordinary `keydown` the handler cannot
 * distinguish from a submit. A field that acts on every Enter therefore fires
 * on the first one - saving an example named by a half-composed romaji buffer,
 * fetching a URL that is still being spelled. `isComposing` is the browser's
 * own answer: it is true for exactly the keystrokes the IME owns.
 *
 * It lives here as one definition rather than seven copies because the guard
 * is invisible when absent - nothing about a plain `e.key === "Enter"` looks
 * wrong, which is how all seven sites came to be missing it at once.
 */

import type { KeyboardEvent } from "react";

/** True for an Enter that should act - not one committing an IME buffer. */
export function isCommitEnter(e: KeyboardEvent): boolean {
	return e.key === "Enter" && !e.nativeEvent.isComposing;
}
