/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Trash Module
 *
 * Where a deleted collection or request goes, and how it comes back.
 *
 * The engine's delete has been soft since issue #988 - the row is stamped with
 * a `deleted_at` and filtered out of every live read, rather than destroyed -
 * and this module is the only surface that shows the stamped rows. Sidebar
 * only, like `services/`: a trash entry has a name, an age and two buttons, so
 * there is nothing a detail pane would hold.
 *
 * The undo toast raised by a delete in the collections tree
 * (`modules/collections/useTreeCrud.ts`) is the other half of the same feature
 * and deliberately lives with the delete rather than here: it belongs to the
 * action, and its window is seconds. This view is the durable half - the
 * retention window is where a restore stays possible for days.
 */

export * from "./sidebar";
