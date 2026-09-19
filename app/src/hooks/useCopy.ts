/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Copy, and say so only once it worked.
 *
 * `writeText` returns a promise that *rejects* - a denied permission, a
 * document that is not focused, a platform with no clipboard behind the API.
 * A call site that fires it with `void` and toasts "copied" unconditionally
 * reports a failed copy as a success, so the user pastes whatever was on the
 * clipboard before, and the rejection goes unhandled.
 *
 * It lives here rather than beside one of its callers because two surfaces
 * offer the same inbox URL - the Services drawer's row and the inbox tab's
 * header - and the tab's button kept the exact defect the drawer's fix removed
 * (issue #555 item 6, then #565 item 1). A hand-rolled copy does not receive
 * the primitive's fixes.
 *
 * `what` names the value in both toasts, so a surface with several copy
 * controls says which one it is talking about.
 *
 * ## The two acknowledgements, and why the failure path is not one of them
 *
 * A copy is acknowledged one of two ways (`feedback`, #1686): a menu item or a
 * text button toasts, an icon button swaps its glyph to a check for
 * `TIMING.COPY_RESET_MS`. Both are *success* idioms. A failure always toasts,
 * in either mode, because there is no failure glyph to swap to - a check that
 * simply never appears is the "the user sees nothing" defect this hook exists
 * to remove, restated as an icon instead of a toast.
 *
 * The reset timer lives here rather than at the six call sites that used to own
 * one, which is how three different durations (1500ms, 2000ms, and a shared
 * transient-status constant)
 * came to acknowledge the same action in the same app.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { TIMING } from "@/config/timing";
import { useToastStore } from "@/stores";

export interface UseCopyOptions {
	/**
	 * How a *successful* copy is reported. Defaults to `"toast"`.
	 *
	 * `"icon"` suppresses the success toast and flips `copied` instead, for an
	 * icon button that swaps Copy to Check (`IconSwap`). A toast beside that
	 * swap would say the same thing twice.
	 */
	feedback?: "toast" | "icon";
}

export interface UseCopyResult {
	/** Copy `value`, naming it `what` in whatever the failure says. */
	copy: (value: string, what: string) => Promise<void>;
	/**
	 * True for `TIMING.COPY_RESET_MS` after a copy that actually landed. Always
	 * false in `"toast"` mode, and never set by a rejected write.
	 */
	copied: boolean;
}

export function useCopy(options: UseCopyOptions = {}): UseCopyResult {
	const { feedback = "toast" } = options;
	const showToast = useToastStore((s) => s.showToast);
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const reset = useCallback(() => setCopied(false), []);

	// A copy on the last frame before an unmount (a dialog that closes on the
	// same click) would otherwise fire its reset into a gone component.
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[]
	);

	const copy = useCallback(
		async (value: string, what: string) => {
			try {
				await navigator.clipboard.writeText(value);
				if (feedback === "icon") {
					// Cleared first, so a second copy inside the window gets the
					// full duration rather than the tail of the previous one.
					if (timer.current) clearTimeout(timer.current);
					setCopied(true);
					timer.current = setTimeout(reset, TIMING.COPY_RESET_MS);
				} else {
					showToast(`${what} copied`, "success");
				}
			} catch (error) {
				showToast(
					error instanceof Error ? `Could not copy: ${error.message}` : "Could not copy",
					"error"
				);
			}
		},
		[feedback, reset, showToast]
	);

	return { copy, copied };
}
