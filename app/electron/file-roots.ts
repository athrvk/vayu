/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The folders the user allowed, as the main process reads them (#2357).
 *
 * `file:stat` answers for a path under one of them, and the engine's
 * `file_roots` table is the record: this keeps a copy of `GET /file-roots`,
 * re-read after the two things that can change it - `file:allowFolder` /
 * `file:removeAllowedFolder` (both run in this process) and an engine start.
 * The engine stores a root canonical, so a caller compares it with a path it
 * has resolved the same way.
 *
 * A read the engine cannot answer yields no folders, never a stale or guessed
 * list: the caller is a gate, and a gate that cannot tell stays shut. The copy
 * stays stale, so the next question asks again.
 */

import type { FileTrustClient } from "./file-trust-client.js";

export interface FileRoots {
	/** The allowed folders now; empty when the engine cannot be asked. */
	list(): Promise<readonly string[]>;
	/** The list may have changed underneath: re-read before it is next trusted. */
	invalidate(): void;
}

export function createFileRoots(client: Pick<FileTrustClient, "listFileRoots">): FileRoots {
	let roots: readonly string[] = [];
	let stale = true;
	// Bumped by invalidate(): a read begun before it is not trusted, so it can
	// neither mark the list fresh nor be joined by a question asked after.
	let generation = 0;
	let reading: Promise<void> | null = null;

	async function read(): Promise<void> {
		const asked = generation;
		const listed = await client.listFileRoots();
		if (asked !== generation) return;
		if (listed.outcome !== "done") {
			roots = [];
			return;
		}
		roots = listed.value.map((row) => row.path);
		stale = false;
	}

	function join(): Promise<void> {
		if (reading) return reading;
		const started = read().finally(() => {
			if (reading === started) reading = null;
		});
		reading = started;
		return started;
	}

	return {
		async list() {
			if (stale) await join();
			// Still stale: an invalidate() landed during the read, so what it
			// listed is not trusted.
			return stale ? [] : roots;
		},

		invalidate() {
			generation += 1;
			stale = true;
			reading = null;
		},
	};
}
