/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useDataFileStore } from "@/stores/data-file-store";
import type { DataFileLocation } from "@/types";

/**
 * Seed one collection's data-file binding into the store that mirrors the
 * collections list (#2765), beside whatever is already there - what the
 * mirror holds once a list carrying that binding lands.
 */
export function bindDataFile(collectionId: string, location: DataFileLocation): void {
	useDataFileStore.setState((state) => ({
		locations: { ...state.locations, [collectionId]: location },
	}));
}
