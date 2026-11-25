/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where a deleted collection, request, environment, saved example or client certificate goes, and
 * how it comes back.
 *
 * The engine's delete is soft (#988): the row is stamped with a `deleted_at` and filtered out of
 * every live read, not destroyed, and this module is the only surface that shows the stamped rows.
 * Sidebar only, like `services/`: a trash entry has a name, an age and two buttons, nothing a
 * detail pane would hold.
 *
 * The undo toast a delete raises (`hooks/useTrashUndo.ts`, called by the collections tree, the
 * Variables view, the Examples panel and the client certificates card) is the other half of the
 * feature and lives with the deletes, deliberately: it belongs to the action, and its window is
 * seconds. This view is the durable half, where a restore stays possible for the retention window.
 */

export * from "./sidebar";
export { retentionCopy, retentionDaysFrom, TRASH_RETENTION_KEY } from "./retention";
// Read by the undo toast (`hooks/useTrashUndo.ts`) as well as by the view here -
// a restore has two callers, and one sentence between them. See the file for why.
export { restoreNotice } from "./restore-notice";
