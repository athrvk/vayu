/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Data File Store
 *
 * Every collection's data file, keyed by collection id (issue #599) - a
 * **mirror** of `Collection.dataFile` across the collections list, not a
 * record of its own. The engine row is the record (#2765), so a backup carries
 * the binding and a trashed collection keeps it; `useFileBindingMirror` copies
 * the list into this map in the same tick the list's cache is written, and
 * nothing else writes it. A binding is changed through the collection update
 * (`dataFile` on `PUT /collections/:id`): `useDataContractWriter` for a pick, a
 * Remove or a change of reading, `recordDataFileHash` for a re-read.
 *
 * Kept as a store for the readers that hold an id rather than a row - the Run
 * dialogs' pre-fill, Send-with-row, a run's file status - and for
 * `useDataFileLocationMirror`, which publishes it to the main process for MCP
 * (issue #1742). It never holds rows: a data file's rows are user data of
 * unknown sensitivity and are persisted nowhere in Vayu.
 */

import { create } from "zustand";
import type { DataFileLocation } from "@/types";

export type { DataFileLocation } from "@/types";

interface DataFileState {
	/** Keyed by collection id; a collection with no entry has no data file. */
	locations: Record<string, DataFileLocation>;
}

export const useDataFileStore = create<DataFileState>()(() => ({ locations: {} }));
