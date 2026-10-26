/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One small JSON object in a file under `userData`, read once and written whole.
 *
 * What the main process's three settings files (`window-state.json`,
 * `response-cache-clear.json`, `mcp-config.json`) need and nothing more: a
 * handful of keys, read at startup, written when they change. They used to be
 * `electron-store`, whose `conf` underneath statically imports Ajv, ajv-formats,
 * semver, dot-prop and atomically for schemas, migrations and watching that
 * none of the three used - measured at 63-77 ms inside Electron to import and
 * construct, and `window-state.ts` constructs its store at module scope, so all
 * of it ran before `app.whenReady` on every launch.
 *
 * The file format is unchanged - the same name under the same directory, the
 * same tab-indented JSON object - so an existing user's files are read as they
 * are, and a downgrade reads what this writes.
 *
 * Three behaviours are kept on purpose:
 *   - An unreadable or corrupt file is an empty store, never a throw. A store
 *     read during startup that threw would leave the app with no window on
 *     every launch until the user found and deleted a hidden file (what
 *     `clearInvalidConfig` was set for on all three).
 *   - The first write over such a file renames it to `<name>.json.corrupt-<ms>`
 *     first (#2433), so what the empty store replaces survives. One copy is kept
 *     per store: a later corruption replaces the earlier copy.
 *   - A write is a temp file renamed over the original, so a crash mid-write
 *     leaves the previous file rather than a truncated one.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

export interface JsonStore<T extends object> {
	get<K extends keyof T>(key: K): T[K] | undefined;
	set<K extends keyof T>(key: K, value: T[K]): void;
	/**
	 * Where the unreadable file this store replaced was kept, once a write has
	 * moved it there; null when the file was usable or the move did not happen.
	 */
	corruptCopy(): string | null;
}

/**
 * Injected rather than imported: `app-log.ts` pulls in the sidecar, and
 * `window-state.ts` builds its store at module scope in main's eager import graph.
 */
export type JsonStoreLog = (message: string, fields: Record<string, unknown>) => void;

/**
 * The directory stores live in when a caller names none - Electron's `userData`,
 * which is where `electron-store` kept them. Read when a store is first used,
 * not when it is created, so a module-scope store costs nothing at import.
 */
function userDataDirectory(): string {
	return app.getPath("userData");
}

const COPY_INFIX = ".corrupt-";

interface LoadedObject {
	data: Record<string, unknown>;
	/** The file exists and this store cannot use it. */
	unreadable: boolean;
}

function readObject(file: string): LoadedObject {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (err) {
		// Missing is a first launch. Any other read failure leaves a file on disk
		// that the empty store is about to replace.
		return { data: {}, unreadable: (err as NodeJS.ErrnoException).code !== "ENOENT" };
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return { data: parsed as Record<string, unknown>, unreadable: false };
		}
	} catch {
		// Falls through: a file that does not parse is as unusable as one that
		// parses to a bare value.
	}
	return { data: {}, unreadable: true };
}

/**
 * Rename an unreadable file to `<file>.corrupt-<ms>` (the engine does the same
 * to `vayu.db`) and drop the older copies, so one is kept. Null when the rename
 * failed, in which case nothing else is touched.
 */
function setAside(file: string, log: JsonStoreLog | undefined): string | null {
	const copy = `${file}${COPY_INFIX}${Date.now()}`;
	try {
		renameSync(file, copy);
	} catch (err) {
		log?.("could not keep a copy of an unreadable settings file", { file, error: String(err) });
		return null;
	}
	log?.("an unreadable settings file was reset; the old file is kept", { file, copy });
	dropOlderCopies(file, copy);
	return copy;
}

function dropOlderCopies(file: string, keep: string): void {
	const directory = path.dirname(file);
	// The full file name, so one store never removes another's copy.
	const prefix = `${path.basename(file)}${COPY_INFIX}`;
	try {
		for (const entry of readdirSync(directory)) {
			const candidate = path.join(directory, entry);
			if (entry.startsWith(prefix) && candidate !== keep) rmSync(candidate, { force: true });
		}
	} catch {
		// Best effort: a leftover older copy is harmless, a failed write is not.
	}
}

/**
 * @param name the file's name without `.json`.
 * @param directory where it lives; `userData` unless a caller (a test) says.
 */
export function createJsonStore<T extends object>(
	name: string,
	directory: () => string = userDataDirectory,
	log?: JsonStoreLog
): JsonStore<T> {
	let data: Record<string, unknown> | null = null;
	let file = "";
	// Set at load, cleared once a write has dealt with the unreadable file, so a
	// valid file is never renamed and a second `set` never renames the first.
	let pendingSetAside = false;
	let copy: string | null = null;

	const load = (): Record<string, unknown> => {
		if (data === null) {
			file = path.join(directory(), `${name}.json`);
			const loaded = readObject(file);
			data = loaded.data;
			pendingSetAside = loaded.unreadable;
		}
		return data;
	};

	return {
		get(key) {
			return load()[key as string] as T[typeof key] | undefined;
		},
		set(key, value) {
			const next = { ...load(), [key as string]: value };
			mkdirSync(path.dirname(file), { recursive: true });
			if (pendingSetAside) {
				pendingSetAside = false;
				copy = setAside(file, log);
			}
			const temp = `${file}.${process.pid}.tmp`;
			writeFileSync(temp, JSON.stringify(next, undefined, "\t"));
			renameSync(temp, file);
			data = next;
		},
		corruptCopy() {
			return copy;
		},
	};
}
