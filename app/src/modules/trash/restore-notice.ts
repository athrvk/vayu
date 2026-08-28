/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { RestoreTrashResponse } from "@/types";

/**
 * What to say about a restore, or null when it needs no explaining.
 *
 * **One function because a restore has two callers.** The Trash view's Restore
 * button and the undo toast raised by a delete both hit
 * `POST /trash/{id}/restore`, and this app's own rule about a response reaching
 * a surface "through two funnels" is that a field read by one and dropped by
 * the other is how they drift - which is exactly what happened here first: the
 * view explained a re-parent and the toast said nothing, so the same restore
 * was self-explanatory or silent depending on which button did it.
 *
 * `reparentedToRoot` is the only thing worth a word. The engine sets it when a
 * collection cannot go back where it came from - its parent is gone, or is
 * itself in the trash - so it clears the parent and the folder returns as a
 * tree root. The row reappears somewhere the user did not put it, and nothing
 * else on screen would say so. (A *request* in that position is refused with a
 * 409 rather than re-parented, so this never speaks for one.)
 */
export function restoreNotice(restored: RestoreTrashResponse, name: string): string | null {
	if (!restored.reparentedToRoot) return null;
	return `Restored "${name}" to the top level - the folder it was in is gone.`;
}
