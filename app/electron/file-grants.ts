/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The files a person picked, as the main process knows them (#2356).
 *
 * The engine sends a file a request body names only when it lies under an
 * allowed folder or a person picked it, and "picked" is a row of its
 * `file_grants` table that only this process can write (the grant secret, see
 * `file-trust-client.ts`). The rows come from exactly two doors, both of which
 * hand over a path the renderer did not compose:
 *
 * - **The preload**, after `webUtils.getPathForFile` answers a path for a
 *   `File` the user chose or dropped, reports it on {@link FILE_PICKED_CHANNEL}.
 *   The channel is the preload's own: no `electronAPI` method takes a string to
 *   it, which `preload-grant-channel.test.ts` holds.
 * - **The OS**, through `open-intent.ts`, for a document dropped on the app's
 *   icon or opened with it.
 *
 * `isGranted` is the read for the main-process readers that act on a
 * renderer-named path (#2357); nothing else may add to the set. The engine's
 * table is the record, and this keeps a copy of `GET /file-grants`, re-read
 * after each engine start because only then can it have changed underneath.
 *
 * A path recorded while the engine cannot be reached - a document opened
 * with the app on a cold launch arrives before the engine listens - is held
 * and sent again by the next `sync`, so it is not lost to the timing.
 */

import { promises as fs } from "fs";
import path from "path";
import type { FileTrustClient } from "./file-trust-client.js";
import type { IpcSenderLike } from "./ipc-sender.js";

/**
 * The preload's one-way report of a picked file's path. Spelled again in
 * preload.ts, which is sandboxed CommonJS and cannot import it;
 * `preload-grant-channel.test.ts` holds the two spellings together.
 */
export const FILE_PICKED_CHANNEL = "file:picked";

export interface FileGrantsDeps {
	client: Pick<FileTrustClient, "createFileGrant" | "listFileGrants">;
	/**
	 * `fs.promises.realpath` by default: the engine stores a grant with every
	 * symlink resolved, so a path is compared in the same spelling.
	 */
	canonical?: (filePath: string) => Promise<string>;
	log: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface FileGrants {
	/** Record a picked path with the engine. Resolves whether the engine holds it now. */
	record(filePath: string): Promise<boolean>;
	/** Whether the engine holds a grant for the file `filePath` names now. */
	isGranted(filePath: string): Promise<boolean>;
	/** Send what is waiting, then re-read the grants if an engine start made them stale. */
	sync(): Promise<void>;
	/** An engine was spawned: the copy is re-read before it is next trusted. */
	invalidate(): void;
}

export function createFileGrants(deps: FileGrantsDeps): FileGrants {
	const canonical = deps.canonical ?? ((filePath: string) => fs.realpath(filePath));
	let granted = new Set<string>();
	let stale = true;
	const pending = new Set<string>();
	let syncing: Promise<void> | null = null;

	/**
	 * One `POST /file-grants`. A path the engine could not be asked about stays
	 * pending; one it answered for, either way, does not.
	 */
	async function send(filePath: string): Promise<boolean> {
		const result = await deps.client.createFileGrant(filePath);
		if (result.outcome === "unreachable") {
			deps.log("A picked file is waiting for the engine to record it", {
				error: result.message,
			});
			return false;
		}
		pending.delete(filePath);
		if (result.outcome === "done") {
			granted.add(result.value.path);
			return true;
		}
		// Already granted, under the canonical spelling the 409 does not carry;
		// the re-read learns it.
		if (result.status === 409) {
			stale = true;
			return true;
		}
		deps.log("The engine refused to record a picked file", {
			status: result.status,
			code: result.code,
		});
		return false;
	}

	async function runSync(): Promise<void> {
		for (const filePath of [...pending]) await send(filePath);
		if (!stale) return;
		const listed = await deps.client.listFileGrants();
		// Left stale on a failed read, so the next question asks again.
		if (listed.outcome !== "done") return;
		granted = new Set(listed.value.map((row) => row.path));
		stale = false;
	}

	function sync(): Promise<void> {
		syncing ??= runSync().finally(() => {
			syncing = null;
		});
		return syncing;
	}

	return {
		record(filePath) {
			pending.add(filePath);
			return send(filePath);
		},

		async isGranted(filePath) {
			if (stale || pending.size > 0) await sync();
			try {
				return granted.has(await canonical(filePath));
			} catch {
				return false;
			}
		},

		sync,

		invalidate() {
			stale = true;
		},
	};
}

/** A path worth sending to `POST /file-grants`: a non-empty absolute path with no NUL. */
export function isRecordablePath(
	filePath: unknown,
	isAbsolute: (filePath: string) => boolean = path.isAbsolute
): filePath is string {
	return (
		typeof filePath === "string" &&
		filePath !== "" &&
		!filePath.includes("\0") &&
		isAbsolute(filePath)
	);
}

interface IpcOnLike {
	on(channel: string, listener: (event: IpcSenderLike, ...args: unknown[]) => void): unknown;
}

export interface FilePickedIpcDeps {
	grants: Pick<FileGrants, "record">;
	/** `isFromAppMainFrame` against the live main window. */
	isAppFrame: (event: IpcSenderLike) => boolean;
	/** The host's absolute-path rule; injectable so both platforms' answers are testable. */
	isAbsolute?: (filePath: string) => boolean;
	log: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * The preload's report of a picked file. One-way: the renderer has nothing to
 * wait on, and an answer would make the channel a probe for what is granted.
 */
export function registerFilePickedIpc(ipc: IpcOnLike, deps: FilePickedIpcDeps): void {
	ipc.on(FILE_PICKED_CHANNEL, (event, filePath: unknown) => {
		if (!deps.isAppFrame(event)) {
			deps.log("Refused a picked file reported from outside the app window");
			return;
		}
		if (!isRecordablePath(filePath, deps.isAbsolute)) {
			deps.log("Refused a picked file that is not an absolute path");
			return;
		}
		void deps.grants.record(filePath);
	});
}
