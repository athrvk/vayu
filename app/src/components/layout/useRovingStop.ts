/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState } from "react";

/**
 * The one `tabIndex={0}` of a roving-tabindex strip, held as state (#1856).
 *
 * Arrow keys move focus without changing the selection, so the stop and the selected item differ
 * until the selection moves. Writing `tabIndex` onto the focused element instead leaves its
 * component's prop unchanged: React never re-applies it, a later selection change adds a second
 * stop beside the stray one, and closing the arrowed-to item leaves none.
 *
 * The stop follows `selected` and departs only while the user has arrowed away:
 *
 * - a move is discarded when the selection changes, in the render that sees the change (an effect
 *   would paint one frame with a stale stop), so returning to an earlier selection does not revive
 *   an old move;
 * - a move whose item is no longer in `present` (closed, or trimmed from the strip) falls back to
 *   the selection rather than leaving the strip with none.
 */
export function useRovingStop<T extends string>(selected: T | null, present: readonly T[]) {
	const [seen, setSeen] = useState(selected);
	const [moved, setMoved] = useState<T | null>(null);

	if (seen !== selected) {
		setSeen(selected);
		setMoved(null);
	}

	const stop = moved !== null && seen === selected && present.includes(moved) ? moved : selected;

	return [stop, setMoved] as const;
}
