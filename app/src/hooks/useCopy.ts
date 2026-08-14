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
 */

import { useToastStore } from "@/stores";

export function useCopy(): (value: string, what: string) => Promise<void> {
	const showToast = useToastStore((s) => s.showToast);
	return async (value: string, what: string) => {
		try {
			await navigator.clipboard.writeText(value);
			showToast(`${what} copied`, "success");
		} catch (error) {
			showToast(
				error instanceof Error ? `Could not copy: ${error.message}` : "Could not copy",
				"error"
			);
		}
	};
}
