/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where each collection's declared data file lives on this machine, as the
 * main process knows it, so the MCP server can name it (issue #1742, Part B).
 *
 * The renderer owns the record (`src/stores/data-file-store.ts`, persisted in
 * its own storage) and publishes the whole map here on launch and on every
 * change; this holds the latest copy. The main process never persists it, so
 * there is still one record and this is a view of it.
 *
 * **Why a path may reach MCP at all:** the Electron-hosted MCP server listens
 * on loopback only (`MCP_HOST`), so every client that can read this answer runs
 * on the machine the path is true of. The standalone stdio server (`mcp/cli.ts`)
 * runs without the app and has no copy, so it never answers a path. The rows are
 * still read by nobody but the app: a client that wants them opens the file
 * with its own filesystem access, the way a person would.
 *
 * An entry is kept only if `dataFile:read` would open it (an absolute path with
 * a data-file extension). A path the app itself refuses to read is not one to
 * hand an agent as "the file", and a published payload is renderer input, so it
 * is rebuilt rather than trusted.
 */

import path from "path";

import { DATA_FILE_EXTENSIONS } from "./data-file.js";

export interface DataFileLocation {
	/** Absolute path on this machine. */
	path: string;
	/** The file's own name when it was picked. */
	fileName: string;
}

/** The entries of a published payload this process is willing to repeat. */
export function normalizeDataFileLocations(payload: unknown): Map<string, DataFileLocation> {
	const locations = new Map<string, DataFileLocation>();
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return locations;
	for (const [collectionId, value] of Object.entries(payload)) {
		const entry = value as Partial<DataFileLocation> | null;
		if (typeof entry?.path !== "string" || typeof entry.fileName !== "string") continue;
		if (!path.isAbsolute(entry.path)) continue;
		if (!DATA_FILE_EXTENSIONS.includes(path.extname(entry.path).toLowerCase())) continue;
		locations.set(collectionId, { path: entry.path, fileName: entry.fileName });
	}
	return locations;
}

export class DataFileLocations {
	private locations = new Map<string, DataFileLocation>();

	/** Replace the whole copy: the renderer always publishes the full map. */
	replace(payload: unknown): void {
		this.locations = normalizeDataFileLocations(payload);
	}

	get(collectionId: string): DataFileLocation | undefined {
		return this.locations.get(collectionId);
	}
}
