/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect, useState } from "react";
import { useDataFileStore } from "@/stores";
import { classifyDataFile, type DataFileStatus } from "@/lib/run-data-file";
import type { DataFileHashReply } from "@/types/electron";
import { canHashDeclaredDataFile, hashDeclaredDataFile } from "@/services/data-files/read-declared";

/**
 * How the file this machine remembers for `collectionId` stands against the one
 * a run read: `changed`, `readingChanged` (same bytes, numbers now read the
 * other way, #2636), `unchanged`, `missing` (no longer at its path, issues
 * #2051 and #2057) or `unknown`. The remembered path is hashed by the main
 * process on mount, on a change of path, and whenever the window regains focus
 * (the user edited, moved or restored the file in another program and came
 * back).
 *
 * Without the hash bridge (a browser build) it compares against the hash
 * `data-file-store` last recorded instead, and can never say `missing`: a
 * browser has no way to look. `unknown` whenever an answer is not to be had:
 * no collection, no remembered location, a hash still in flight, a hash that
 * failed for a reason other than the file being gone, or (for every verdict
 * but `missing`) a run recorded before hashes - see `classifyDataFile`.
 *
 * `runCastNumbers` is the run's recorded reading; the binding's is read from
 * the store beside the path, and each is off when absent.
 *
 * Only a collection run has a collection to ask; a load run's file has no
 * remembered location of its own, so its surfaces do not call this.
 */
export function useDataFileStatus(
	collectionId: string | undefined,
	runHash: string | undefined,
	runCastNumbers: boolean | undefined
): DataFileStatus {
	const location = useDataFileStore((s) =>
		collectionId === undefined ? undefined : s.locations[collectionId]
	);
	const bridged = canHashDeclaredDataFile();
	const reply = useCurrentDataFileReply(bridged ? location?.path : undefined);
	const storedHash = location?.hash;
	const current: DataFileHashReply | undefined = bridged
		? reply
		: storedHash === undefined
			? undefined
			: { status: "found", hash: storedHash };
	return classifyDataFile(runHash, current, runCastNumbers, location?.castNumbers);
}

type ReplyState = { path: string; reply: DataFileHashReply } | null;

/** The main process's answer about the file at `path` now; undefined while unknown or for no path. */
function useCurrentDataFileReply(path: string | undefined): DataFileHashReply | undefined {
	const [state, setState] = useState<ReplyState>(null);
	useEffect(() => {
		if (!path) return;
		let current = true;
		const check = () => {
			hashDeclaredDataFile(path)
				.then((reply) => {
					if (current) setState({ path, reply });
				})
				.catch(() => {
					// Unknown rather than changed or missing: a refusal is not
					// evidence about the file, only a "missing" reply is.
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
	return state && state.path === path ? state.reply : undefined;
}
