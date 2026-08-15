/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Spec File Store
 *
 * Where a collection's bound OpenAPI document lives on **this machine** - one
 * `{path, fileName}` per collection id, for the specs that were picked as files
 * rather than fetched from a URL (issue #638).
 *
 * The same two-halves law `data-file-store` follows, and for the same reason:
 *
 * - **It is not the document.** The spec's bytes are engine state
 *   (`spec_documents.content`, bound by `Collection.openapi.specId`), because
 *   they are the same on every machine and travel through import. A *path* is
 *   true of one filesystem only, so it stays here and never reaches the engine,
 *   an export or MCP.
 * - **It never holds spec content.** Only the path and the file's name are
 *   persisted, and `spec-file-store.test.ts` asserts the persisted payload
 *   against that rule rather than trusting it.
 *
 * A URL-sourced spec has no entry here at all: its origin is
 * `spec_documents.source_url`, which is portable and is what a re-fetch (#627)
 * will use. This store answers the other half of "where did this come from" -
 * the half a URL cannot.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/constants/storage-keys";

/** Where a collection's spec document was last picked from, on this machine. */
export interface SpecFileLocation {
	/** Absolute path, obtained from the preload `getFilePath` bridge at pick time. */
	path: string;
	/** The file's own name, which is what the Spec tab shows as the source. */
	fileName: string;
}

interface SpecFileState {
	/** Keyed by collection id; a collection with no entry has no remembered file. */
	locations: Record<string, SpecFileLocation>;

	setSpecFile: (collectionId: string, location: SpecFileLocation) => void;
	clearSpecFile: (collectionId: string) => void;
}

interface PersistedSpecFiles {
	locations: Record<string, SpecFileLocation>;
}

/**
 * Normalize a persisted payload into locations this app is willing to open.
 *
 * Rebuilt rather than trusted, and wired as **both** `migrate` and `merge`, for
 * the reasons written out in `data-file-store.ts`: `migrate` runs only on a
 * version change, `merge` on every rehydrate, and the same-version payload is
 * the overwhelmingly common case.
 */
function normalizeSpecFiles(persisted: unknown): PersistedSpecFiles {
	const stored = (persisted ?? {}) as Partial<PersistedSpecFiles>;
	const locations: Record<string, SpecFileLocation> = {};
	if (stored.locations && typeof stored.locations === "object") {
		for (const [collectionId, value] of Object.entries(stored.locations)) {
			const entry = value as Partial<SpecFileLocation> | null;
			if (typeof entry?.path === "string" && typeof entry?.fileName === "string") {
				locations[collectionId] = { path: entry.path, fileName: entry.fileName };
			}
		}
	}
	return { locations };
}

export const useSpecFileStore = create<SpecFileState>()(
	persist(
		(set) => ({
			locations: {},
			setSpecFile: (collectionId, location) =>
				set((state) => ({ locations: { ...state.locations, [collectionId]: location } })),
			clearSpecFile: (collectionId) =>
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
			name: STORAGE_KEYS.SPEC_FILE_STORE,
			version: 1,
			partialize: (state) => ({ locations: state.locations }),
			migrate: normalizeSpecFiles,
			merge: (persisted, current) => ({ ...current, ...normalizeSpecFiles(persisted) }),
		}
	)
);
