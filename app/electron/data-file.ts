/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Reading a collection's declared data file back from disk (issue #599).
 *
 * **This widens a documented posture, deliberately.** Until now the renderer
 * could never name a path: `getFilePath` (preload.ts) turns a `File` the user
 * picked into a path *inside the preload*, synchronously, so there is no channel
 * on which the web layer can ask for a file of its own choosing. This module
 * adds exactly that channel, because the Run dialog has to re-open a file the
 * user picked in an earlier session and the `File` object is long gone.
 *
 * What keeps it from being "read any file": every read passes two gates, in this
 * order, before a byte is touched.
 *
 *  1. **Extension allowlist** - the same extensions the picker accepts and
 *     nothing else, so the channel cannot be pointed at a key, a database or a
 *     dotfile. Parity with the picker is test-pinned
 *     (`data-file.parity.test.ts`); an allowlist narrower than the picker would
 *     be worse than none, because it would remember a file it then refuses.
 *  2. **The engine's `maxScenarioDataBytes`, fetched** - never a second copy of
 *     the rule. A user who raises the setting can pre-fill the bigger file the
 *     same session; a user who lowers it is refused here rather than at
 *     `POST /runs`. The seed below stands only while the engine is unreachable,
 *     and is the number the engine itself seeds.
 *
 * **Rejected alternative, for the record:** a main-process allowlist of paths
 * registered when the user picks a file. It reads like a stronger gate and is
 * not one - provenance cannot actually be verified across restarts (the
 * registry would be persisted renderer-side, which is the thing being gated),
 * so it is ceremony over a check that the extension allowlist already makes.
 *
 * The handler returns **bytes, not text**. Decoding is
 * `services/data-files/decode.ts`'s job on the renderer side, and it does more
 * than a UTF-8 decode - a UTF-16 BOM sniff, a replacement-character refusal. A
 * second decode here would mean a file read through the picker and the same file
 * read through this channel could disagree about their own contents.
 */

import { promises as fs } from "fs";
import path from "path";

import { ENGINE_HOST, ENGINE_PORT, DATA_FILE_MAX_BYTES_SEED } from "./constants.js";

/**
 * Extensions this channel will open, lower-cased and with the dot.
 *
 * Must equal what `DATA_FILE_ACCEPT` (services/data-files) offers the picker -
 * see the parity test. Duplicated rather than imported because the main process
 * is built from tsconfig.node.json and cannot reach renderer modules, which is
 * the same reason `ENGINE_PORT` is duplicated in `src/config/network.ts`.
 */
export const DATA_FILE_EXTENSIONS: readonly string[] = [
	".csv",
	".tsv",
	".tab",
	".json",
	".jsonl",
	".ndjson",
];

/** What the handler resolves to: the file's bytes and the name it has now. */
export interface DataFileReadResult {
	bytes: Uint8Array;
	fileName: string;
}

/** The I/O this module performs, injected so the gates are testable without a disk. */
export interface DataFileSystem {
	stat: (filePath: string) => Promise<{ size: number; isFile: () => boolean }>;
	readFile: (filePath: string) => Promise<Buffer>;
	fetchConfig: () => Promise<unknown>;
}

const defaultSystem: DataFileSystem = {
	stat: (filePath) => fs.stat(filePath),
	readFile: (filePath) => fs.readFile(filePath),
	fetchConfig: async () => {
		const response = await fetch(`http://${ENGINE_HOST}:${ENGINE_PORT}/config`);
		if (!response.ok) throw new Error(`config responded ${response.status}`);
		return await response.json();
	},
};

/**
 * The live `maxScenarioDataBytes`, or the seed when the engine cannot answer.
 *
 * Falling back rather than failing: an unreachable engine is a state the user is
 * about to hit anyway (they cannot start a run either), and refusing to *read*
 * would report it as a problem with their file.
 */
async function maxDataFileBytes(system: DataFileSystem): Promise<number> {
	try {
		const config = (await system.fetchConfig()) as {
			entries?: { key?: string; value?: string }[];
		};
		const entry = config?.entries?.find((e) => e.key === "maxScenarioDataBytes");
		const value = Number(entry?.value);
		if (Number.isFinite(value) && value > 0) return value;
	} catch {
		// Fall through to the seed.
	}
	return DATA_FILE_MAX_BYTES_SEED;
}

/**
 * Read a declared data file, or throw a message the dialog can show as-is.
 *
 * Every refusal names what is wrong with *the file*, because that is what the
 * user can act on: a wrong extension, a file that has moved, a file over the
 * engine's cap - naming the setting, so "raise it" is actionable.
 */
export async function readDataFile(
	filePath: string,
	system: DataFileSystem = defaultSystem
): Promise<DataFileReadResult> {
	if (typeof filePath !== "string" || filePath.trim() === "") {
		throw new Error("No data file path was given.");
	}

	const extension = path.extname(filePath).toLowerCase();
	if (!DATA_FILE_EXTENSIONS.includes(extension)) {
		throw new Error(
			`Vayu only opens data files (${DATA_FILE_EXTENSIONS.join(", ")}), and this one is "${extension || "extensionless"}".`
		);
	}

	let size: number;
	try {
		const stats = await system.stat(filePath);
		if (!stats.isFile()) throw new Error("not a file");
		size = stats.size;
	} catch {
		throw new Error(`The file is no longer at ${filePath} - pick it again.`);
	}

	const maxBytes = await maxDataFileBytes(system);
	if (size > maxBytes) {
		throw new Error(
			`The file is ${size} bytes, over the ${maxBytes} a run may carry. Raise the maxScenarioDataBytes engine setting, or split the file.`
		);
	}

	const buffer = await system.readFile(filePath);
	return {
		bytes: new Uint8Array(buffer),
		fileName: path.basename(filePath),
	};
}
