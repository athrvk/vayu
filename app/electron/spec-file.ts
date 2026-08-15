/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Reading the files an imported OpenAPI document references (issue #649).
 *
 * A multi-file spec names its siblings by relative path - `./schemas/pet.yaml`,
 * `../shared/error.yaml` - and until those are read, every operation that
 * depends on one imports short with nothing said about it. The file the user
 * picked arrives as a `File`; its neighbours never do, so this is the channel
 * that reads them.
 *
 * **The renderer never names a directory here.** It passes the picked
 * document's path (which it already holds from `getFilePath`) and the ref's own
 * text, and the resolution happens *in this process*. That is the difference
 * between "read a file this document asked for" and "read a path the web layer
 * composed", and it is why the two arguments are not one.
 *
 * The gates are `data-file.ts`'s, for the same reasons stated there at length:
 *
 *  1. **Extension allowlist** - the three a spec can be written in and nothing
 *     else, so the channel cannot be pointed at a key, a database or a dotfile.
 *  2. **The engine's `maxSpecDocumentBytes`, fetched** - never a second copy of
 *     the rule. The bundle has to fit what `POST /specs` will store, and a user
 *     who raises the setting can import the bigger spec the same session.
 *
 * **A ref that climbs out of the spec's directory is allowed**, and that is a
 * decision rather than an oversight: `spec/openapi.yaml` referencing
 * `../shared/error.yaml` is an ordinary layout, and the file is named by a
 * document the user chose to import. A directory jail would refuse real specs
 * while adding nothing the extension allowlist does not already give - the same
 * reasoning that rejected a registry of picked paths for `dataFile:read`.
 *
 * Bytes, not text, again matching `dataFile:read`: decoding belongs to one place
 * on the renderer side, so a sibling read here cannot disagree with the picked
 * file read through `FileReader`.
 */

import { promises as fs } from "fs";
import path from "path";

import { ENGINE_HOST, ENGINE_PORT, SPEC_DOCUMENT_MAX_BYTES_SEED } from "./constants.js";

/** Extensions this channel will open, lower-cased and with the dot. */
export const SPEC_FILE_EXTENSIONS: readonly string[] = [".json", ".yaml", ".yml"];

/** What the handler resolves to: the file's bytes and the name it has now. */
export interface SpecFileReadResult {
	bytes: Uint8Array;
	fileName: string;
}

/** The I/O this module performs, injected so the gates are testable without a disk. */
export interface SpecFileSystem {
	stat: (filePath: string) => Promise<{ size: number; isFile: () => boolean }>;
	readFile: (filePath: string) => Promise<Buffer>;
	fetchConfig: () => Promise<unknown>;
}

const defaultSystem: SpecFileSystem = {
	stat: (filePath) => fs.stat(filePath),
	readFile: (filePath) => fs.readFile(filePath),
	fetchConfig: async () => {
		const response = await fetch(`http://${ENGINE_HOST}:${ENGINE_PORT}/config`);
		if (!response.ok) throw new Error(`config responded ${response.status}`);
		return await response.json();
	},
};

/**
 * The live `maxSpecDocumentBytes`, or the seed when the engine cannot answer.
 *
 * Falling back rather than failing, as the data-file channel does: an
 * unreachable engine is a state the user is about to hit anyway - the import
 * cannot be applied either - and refusing to *read* would report it as a problem
 * with their spec.
 */
async function maxSpecFileBytes(system: SpecFileSystem): Promise<number> {
	try {
		const config = (await system.fetchConfig()) as {
			entries?: { key?: string; value?: string }[];
		};
		const entry = config?.entries?.find((e) => e.key === "maxSpecDocumentBytes");
		const value = Number(entry?.value);
		if (Number.isFinite(value) && value > 0) return value;
	} catch {
		// Fall through to the seed.
	}
	return SPEC_DOCUMENT_MAX_BYTES_SEED;
}

/**
 * Read one file referenced by an imported spec, or throw a message the import
 * dialog can show as-is.
 *
 * @param specPath the document the user picked - only its directory is used.
 * @param refPath the `$ref` target as the document wrote it, relative to that
 * directory.
 */
export async function readSpecFile(
	specPath: string,
	refPath: string,
	system: SpecFileSystem = defaultSystem
): Promise<SpecFileReadResult> {
	if (typeof specPath !== "string" || specPath.trim() === "") {
		throw new Error("No spec file path was given.");
	}
	if (typeof refPath !== "string" || refPath.trim() === "") {
		throw new Error("No referenced file was named.");
	}
	if (path.isAbsolute(refPath)) {
		// A spec that names an absolute path describes one machine's disk, not a
		// document. Refusing is honest; resolving it would make an import behave
		// differently on the author's machine than on anyone else's.
		throw new Error(`"${refPath}" is an absolute path, and a spec reference must be relative.`);
	}

	const resolved = path.resolve(path.dirname(specPath), refPath);
	const extension = path.extname(resolved).toLowerCase();
	if (!SPEC_FILE_EXTENSIONS.includes(extension)) {
		throw new Error(
			`Vayu only opens spec files (${SPEC_FILE_EXTENSIONS.join(", ")}), and this reference is "${extension || "extensionless"}".`
		);
	}

	let size: number;
	try {
		const stats = await system.stat(resolved);
		if (!stats.isFile()) throw new Error("not a file");
		size = stats.size;
	} catch {
		throw new Error(`The spec references ${refPath}, which is not at ${resolved}.`);
	}

	const maxBytes = await maxSpecFileBytes(system);
	if (size > maxBytes) {
		throw new Error(
			`${refPath} is ${size} bytes, over the ${maxBytes} one document may hold. Raise the maxSpecDocumentBytes engine setting, or split the spec.`
		);
	}

	const buffer = await system.readFile(resolved);
	return {
		bytes: new Uint8Array(buffer),
		fileName: path.basename(resolved),
	};
}
