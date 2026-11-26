/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Copy, and say so only once it worked. `writeText` returns a promise that *rejects* (a denied
 * permission, an unfocused document, a platform with no clipboard behind the API), so a call site
 * that fires it with `void` and toasts "copied" unconditionally reports a failed copy as a success:
 * the user pastes whatever was on the clipboard before, and the rejection goes unhandled.
 *
 * Here rather than beside a caller because two surfaces offer the same inbox URL (the Services
 * drawer's row and the inbox tab's header), and the tab's button kept the exact defect the drawer's
 * fix removed (#555 item 6, then #565 item 1). A hand-rolled copy does not receive the primitive's
 * fixes.
 *
 * `what` names the value in both toasts, so a surface with several copy controls says which one it
 * means.
 *
 * ## The two acknowledgements, and why the failure path is not one of them
 *
 * A copy is acknowledged one of two ways (`feedback`, #1686): a menu item or a text button toasts,
 * an icon button swaps its glyph to a check for `TIMING.COPY_RESET_MS`. Both are *success* idioms.
 * A failure always toasts, in either mode: there is no failure glyph to swap to, and a check that
 * never appears is the "the user sees nothing" defect this hook exists to remove, as an icon
 * instead of a toast.
 *
 * The reset timer lives here, not at the call sites: six sites that each owned one acknowledged the
 * same action with three different durations (1500ms, 2000ms and a shared transient-status
 * constant).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { TIMING } from "@/config/timing";
import { useToastStore } from "@/stores";

export interface UseCopyOptions {
	/**
	 * How a *successful* copy is reported; defaults to `"toast"`. `"icon"` suppresses the success
	 * toast and flips `copied` instead, for an icon button that swaps Copy to Check (`IconSwap`); a
	 * toast beside that swap would say the same thing twice.
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
					error instanceof Error ? `Couldn't copy: ${error.message}` : "Couldn't copy",
					"error"
				);
			}
		},
		[feedback, reset, showToast]
	);

	return { copy, copied };
}
