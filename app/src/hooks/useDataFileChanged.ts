/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useDataFileStore } from "@/stores";
import { dataFileChanged } from "@/lib/run-data-file";

/**
 * Whether the file this machine remembers for `collectionId` no longer matches
 * the one a run read (issue #2051), from the hash the app last read it with.
 *
 * Only a collection run has a collection to ask; a load run's file has no
 * remembered location of its own, so its surfaces do not call this. False for
 * an unknown collection or either hash being unknown (see `dataFileChanged`).
 * A path that has gone missing is not detected here: the store keeps the last
 * hash it saw, and the only signal for a missing file is a read that failed,
 * which `useDeclaredDataFile` holds inside a dialog.
 */
export function useDataFileChanged(
	collectionId: string | undefined,
	runHash: string | undefined
): boolean {
	const rememberedHash = useDataFileStore((s) =>
		collectionId === undefined ? undefined : s.locations[collectionId]?.hash
	);
	return dataFileChanged(runHash, rememberedHash);
}
