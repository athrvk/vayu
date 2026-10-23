/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Spec File Store
 *
 * Every collection's picked spec file, keyed by collection id (issue #638) -
 * a **mirror** of `Collection.specFile` across the collections list, not a
 * record of its own. The engine row is the record (#2765), so a backup carries
 * the binding and a trashed collection keeps it; `useFileBindingMirror` copies
 * the list into this map in the same tick the list's cache is written, and
 * nothing else writes it. A binding is changed through the collection update
 * (`specFile` on `PUT /collections/:id`), never here.
 *
 * Kept as a store for the readers that hold an id rather than a row. A reader
 * that holds the `Collection` reads `collection.specFile` directly.
 */

import { create } from "zustand";
import type { SpecFileLocation } from "@/types";

export type { SpecFileLocation } from "@/types";

interface SpecFileState {
	/** Keyed by collection id; a collection with no entry has no picked file. */
	locations: Record<string, SpecFileLocation>;
}

export const useSpecFileStore = create<SpecFileState>()(() => ({ locations: {} }));
