/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Data File Store
 *
 * Where a collection's data file lives on **this machine** - one
 * `{path, fileName}` per collection id, so the Run dialog can re-read the file
 * the user declared their contract from instead of asking for it every time
 * (issue #599).
 *
 * Two things this store is deliberately not:
 *
 * - **It is not the contract.** The declared columns are collection state and
 *   ride the engine row (`Collection.dataSchema`), because they are the same on
 *   every machine and travel through import. A *path* is true of one filesystem
 *   only, so it stays here and never reaches the engine, an export or MCP.
 * - **It never holds rows.** A data file's rows are user data of unknown
 *   sensitivity and are persisted nowhere in Vayu - not here, not engine-side,
 *   not in a run snapshot (which records `dataRowCount` and nothing else). Only
 *   the path and the file's name are stored, and `data-file-store.test.ts`
 *   asserts the persisted payload against that rule rather than trusting it.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/constants/storage-keys";

/** Where a collection's data file was last picked from, on this machine. */
export interface DataFileLocation {
	/** Absolute path, obtained from the preload `getFilePath` bridge at pick time. */
	path: string;
	/** The file's own name, for a message about a file that has since moved. */
	fileName: string;
}

interface DataFileState {
	/** Keyed by collection id; a collection with no entry has no remembered file. */
	locations: Record<string, DataFileLocation>;

	setDataFile: (collectionId: string, location: DataFileLocation) => void;
	clearDataFile: (collectionId: string) => void;
}

interface PersistedDataFiles {
	locations: Record<string, DataFileLocation>;
}

/**
 * Normalize a persisted payload into locations this app is willing to open.
 *
 * Rebuilt rather than trusted: an entry that is not a `{path, fileName}` pair of
 * strings would reach the read IPC *as a path*, and a half-written or
 * hand-edited payload must not be what names a file to open. Dropping a bad
 * entry is right where repairing it is not - there is nothing to repair a path
 * *to*, and the picker is one click away.
 *
 * Wired as **both** `migrate` and `merge` below, deliberately. `migrate` runs
 * only when the stamped version differs (without it zustand throws the whole
 * payload away, so the next bump needs it); `merge` runs on every rehydrate,
 * which is what makes the normalization apply to the same-version payload that
 * is the overwhelmingly common case.
 */
function normalizeDataFiles(persisted: unknown): PersistedDataFiles {
	const stored = (persisted ?? {}) as Partial<PersistedDataFiles>;
	const locations: Record<string, DataFileLocation> = {};
	if (stored.locations && typeof stored.locations === "object") {
		for (const [collectionId, value] of Object.entries(stored.locations)) {
			const entry = value as Partial<DataFileLocation> | null;
			if (typeof entry?.path === "string" && typeof entry?.fileName === "string") {
				locations[collectionId] = { path: entry.path, fileName: entry.fileName };
			}
		}
	}
	return { locations };
}

export const useDataFileStore = create<DataFileState>()(
	persist(
		(set) => ({
			locations: {},
			setDataFile: (collectionId, location) =>
				set((state) => ({ locations: { ...state.locations, [collectionId]: location } })),
			clearDataFile: (collectionId) =>
				set((state) => {
					// Rebuilt without the key rather than set to undefined: an
					// `undefined` value survives `Object.entries` and would be read
					// back as an entry whose path is not a string.
					const next = { ...state.locations };
					delete next[collectionId];
					return { locations: next };
				}),
		}),
		{
			name: STORAGE_KEYS.DATA_FILE_STORE,
			version: 1,
			partialize: (state) => ({ locations: state.locations }),
			migrate: normalizeDataFiles,
			merge: (persisted, current) => ({ ...current, ...normalizeDataFiles(persisted) }),
		}
	)
);
