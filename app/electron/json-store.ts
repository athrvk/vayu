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
 * Two behaviours are kept on purpose:
 *   - An unreadable or corrupt file is an empty store, never a throw. A store
 *     read during startup that threw would leave the app with no window on
 *     every launch until the user found and deleted a hidden file (what
 *     `clearInvalidConfig` was set for on all three).
 *   - A write is a temp file renamed over the original, so a crash mid-write
 *     leaves the previous file rather than a truncated one.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

export interface JsonStore<T extends object> {
	get<K extends keyof T>(key: K): T[K] | undefined;
	set<K extends keyof T>(key: K, value: T[K]): void;
}

/**
 * The directory stores live in when a caller names none - Electron's `userData`,
 * which is where `electron-store` kept them. Read when a store is first used,
 * not when it is created, so a module-scope store costs nothing at import.
 */
function userDataDirectory(): string {
	return app.getPath("userData");
}

function readObject(file: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		// Missing is a first launch; anything else is a file this store cannot
		// use. Either way the answer is the empty store (see the file comment).
		return {};
	}
}

/**
 * @param name the file's name without `.json`.
 * @param directory where it lives; `userData` unless a caller (a test) says.
 */
export function createJsonStore<T extends object>(
	name: string,
	directory: () => string = userDataDirectory
): JsonStore<T> {
	let data: Record<string, unknown> | null = null;
	let file = "";

	const load = (): Record<string, unknown> => {
		if (data === null) {
			file = path.join(directory(), `${name}.json`);
			data = readObject(file);
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
			const temp = `${file}.${process.pid}.tmp`;
			writeFileSync(temp, JSON.stringify(next, undefined, "\t"));
			renameSync(temp, file);
			data = next;
		},
	};
}
