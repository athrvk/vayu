/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Reading a collection's declared data file back from disk (issue #599).
 *
 * A channel on which the renderer names a path. The Run dialog has to re-open a
 * file the user picked in an earlier session and the `File` object is long
 * gone, so the web layer hands back the path it remembered. A remembered path is
 * a claim, not proof, so every read passes three gates in this order before a
 * byte is touched.
 *
 *  1. **Extension allowlist** - the same extensions the picker accepts and
 *     nothing else, so the channel is not pointed at a key, a database or a
 *     dotfile. Parity with the picker is test-pinned (`data-file.test.ts`); an
 *     allowlist narrower than the picker would be worse than none, because it
 *     would remember a file it then refuses.
 *  2. **The grant** (#2357) - the path must be one the user picked, dropped or
 *     opened, as main's registry knows it (`file-grants.ts`). The extension
 *     allowlist cannot tell a data file from a credentials `.json`; the grant
 *     can, because it is recorded when the user chooses the file, by the
 *     preload from a real `File` and never from a string the renderer
 *     supplies. The registry is persisted by the engine's `file_grants` table,
 *     so it survives a restart; a data file declared before grants existed
 *     must be picked once more. It is checked *after* the stat, so a granted
 *     file that has moved still says it has moved.
 *  3. **The engine's `maxScenarioDataBytes`, fetched** - never a second copy of
 *     the rule. A user who raises the setting can pre-fill the bigger file the
 *     same session; a user who lowers it is refused here rather than at
 *     `POST /runs`. The seed below stands only while the engine is unreachable,
 *     and is the number the engine itself seeds.
 *
 * The handler returns **bytes, not text**. Decoding is
 * `services/data-files/decode.ts`'s job on the renderer side, and it does more
 * than a UTF-8 decode - a UTF-16 BOM sniff, a replacement-character refusal. A
 * second decode here would mean a file read through the picker and the same file
 * read through this channel could disagree about their own contents.
 *
 * `dataFile:hash` (issue #2051) is the same channel answering a digest instead
 * of bytes, behind the same path gates: `hashDataFile`. Its reply says
 * "missing" as data rather than as an exception (issue #2057): an error crossing
 * IPC keeps only its message, and a surface cannot branch on a sentence. A path
 * that holds no grant answers the same `missing` (the surface shows "pick it
 * again", which is the cure), while `hashDataFile` itself rejects with
 * `FileNotGrantedError`, so a caller outside IPC can tell the two apart.
 */

import { createHash } from "crypto";
import { createReadStream, promises as fs } from "fs";
import path from "path";

import { DATA_FILE_MAX_BYTES_SEED } from "./constants.js";
import { engineOrigin } from "./engine-endpoint.js";
import { engineFetch } from "./engine-fetch.js";
import { assertGranted, FileNotGrantedError, type IsGranted } from "./file-grants.js";

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
	/**
	 * SHA-256 of `bytes`, as 64 lowercase hex characters (issue #2051): what a
	 * run records as the file it was driven by. A hand-picked file never comes
	 * through here, so the picker hashes its own bytes (`sha256Hex` in
	 * `services/data-files`) and the two are held to one digest by its test.
	 */
	hash: string;
}

/**
 * The shape of a data file's content hash, wherever one is read back from
 * renderer input (`data-file-locations.ts`) or an MCP argument. The engine
 * refuses any other spelling of the digest.
 */
export const DATA_FILE_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The file is not at the path: it was moved or deleted, or is not a regular
 * file. Thrown only for that, so a caller that must tell "gone" from "refused"
 * (a wrong extension, an empty path) tests the class rather than the message.
 */
export class DataFileMissingError extends Error {
	constructor(filePath: string) {
		super(`The file is no longer at ${filePath} - pick it again.`);
		this.name = "DataFileMissingError";
	}
}

/**
 * What `dataFile:hash` resolves to. Mirrored by `DataFileHashReply` in
 * `src/types/electron.d.ts`, which the preload cannot import either.
 */
export type DataFileHashReply = { status: "found"; hash: string } | { status: "missing" };

/** The I/O this module performs, injected so the gates are testable without a disk. */
export interface DataFileSystem {
	stat: (filePath: string) => Promise<{ size: number; isFile: () => boolean }>;
	readFile: (filePath: string) => Promise<Buffer>;
	/** SHA-256 hex of the file's bytes, streamed rather than read whole. */
	hashFile: (filePath: string) => Promise<string>;
	fetchConfig: () => Promise<unknown>;
	/**
	 * Whether the user picked, dropped or opened this path (`FileGrants.isGranted`).
	 * Required, so a reader wired without the registry fails type-check rather
	 * than reading anything.
	 */
	isGranted: IsGranted;
}

/** The real filesystem and engine, gated by @p isGranted. */
export function createDataFileSystem(isGranted: IsGranted): DataFileSystem {
	return {
		stat: (filePath) => fs.stat(filePath),
		readFile: (filePath) => fs.readFile(filePath),
		hashFile: async (filePath) => {
			const hash = createHash("sha256");
			for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
			return hash.digest("hex");
		},
		fetchConfig: async () => {
			const response = await engineFetch(`${engineOrigin()}/config`);
			if (!response.ok) throw new Error(`config responded ${response.status}`);
			return await response.json();
		},
		isGranted,
	};
}

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
 * @throws FileNotGrantedError when @p filePath is not a granted file.
 *
 * Every refusal names what is wrong with *the file*, because that is what the
 * user can act on: a wrong extension, a file that has moved, a file over the
 * engine's cap - naming the setting, so "raise it" is actionable.
 */
export async function readDataFile(
	filePath: string,
	system: DataFileSystem
): Promise<DataFileReadResult> {
	const size = await statOpenableDataFile(filePath, system);

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
		hash: createHash("sha256").update(buffer).digest("hex"),
	};
}

/**
 * The SHA-256 hex of a declared data file's bytes as they are now (issue
 * #2051), the digest {@link readDataFile} answers for the same bytes, without
 * carrying them: what a surface compares a run's `dataFileHash` against.
 *
 * The same path gates as a read, so this channel answers about no file the
 * read channel would refuse to open. No byte cap: nothing crosses to the
 * renderer and the stream hashes in constant memory, and a file that has
 * outgrown the cap has still changed.
 */
export async function hashDataFile(filePath: string, system: DataFileSystem): Promise<string> {
	await statOpenableDataFile(filePath, system);
	try {
		return await system.hashFile(filePath);
	} catch {
		throw new DataFileMissingError(filePath);
	}
}

/**
 * {@link hashDataFile} as the `dataFile:hash` reply: a file that is not at the
 * path, or not one the user granted, is the answer `{ status: "missing" }`, not
 * a rejection - the surface's cure for both is to pick the file again. Every
 * other refusal (extension, empty path) still rejects, because those are faults
 * in the request and say nothing about the file.
 */
export async function hashDataFileReply(
	filePath: string,
	system: DataFileSystem
): Promise<DataFileHashReply> {
	try {
		return { status: "found", hash: await hashDataFile(filePath, system) };
	} catch (error) {
		if (error instanceof DataFileMissingError || error instanceof FileNotGrantedError) {
			return { status: "missing" };
		}
		throw error;
	}
}

/**
 * The gates both channels pass before a byte is touched; answers the file's
 * size. The grant comes last so a granted file that has moved is reported as
 * moved.
 */
async function statOpenableDataFile(filePath: string, system: DataFileSystem): Promise<number> {
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
		throw new DataFileMissingError(filePath);
	}

	await assertGranted(system.isGranted, filePath);
	return size;
}
