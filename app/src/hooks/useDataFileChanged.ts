/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect, useState } from "react";
import { useDataFileStore } from "@/stores";
import { dataFileChanged } from "@/lib/run-data-file";
import { canHashDeclaredDataFile, hashDeclaredDataFile } from "@/services/data-files/read-declared";

/**
 * Whether the file this machine remembers for `collectionId` no longer matches
 * the one a run read (issue #2051): `runHash` against the SHA-256 of the
 * remembered path's bytes **as they are now**, asked of the main process on
 * mount, on a change of path, and whenever the window regains focus (the user
 * edited the file in another program and came back).
 *
 * Without the hash bridge (a browser build) it compares against the hash
 * `data-file-store` last recorded instead. False whenever an answer is
 * unknown: no collection, no remembered location, a run recorded before
 * hashes, a hash still in flight, or a file that cannot be hashed (moved,
 * deleted) - see `dataFileChanged`.
 *
 * Only a collection run has a collection to ask; a load run's file has no
 * remembered location of its own, so its surfaces do not call this.
 */
export function useDataFileChanged(
	collectionId: string | undefined,
	runHash: string | undefined
): boolean {
	const location = useDataFileStore((s) =>
		collectionId === undefined ? undefined : s.locations[collectionId]
	);
	const bridged = canHashDeclaredDataFile();
	const currentHash = useCurrentDataFileHash(bridged ? location?.path : undefined);
	return dataFileChanged(runHash, bridged ? currentHash : location?.hash);
}

type HashState = { path: string; hash: string } | null;

/** The digest of the file at `path` now; undefined while unknown or for no path. */
function useCurrentDataFileHash(path: string | undefined): string | undefined {
	const [state, setState] = useState<HashState>(null);
	useEffect(() => {
		if (!path) return;
		let current = true;
		const check = () => {
			hashDeclaredDataFile(path)
				.then((hash) => {
					if (current) setState({ path, hash });
				})
				.catch(() => {
					// Unknown rather than changed: a file that cannot be hashed
					// is not evidence about its contents.
					if (current) setState(null);
				});
		};
		check();
		window.addEventListener("focus", check);
		return () => {
			current = false;
			window.removeEventListener("focus", check);
		};
	}, [path]);
	// An answer for the previous path is no answer.
	return state && state.path === path ? state.hash : undefined;
}
