/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Reading the files an imported OpenAPI document references (issue #649, and
 * #1782 for the confinement below).
 *
 * A multi-file spec names its siblings by relative path - `./schemas/pet.yaml`,
 * `../shared/error.yaml` - and until those are read, every operation that
 * depends on one imports short with nothing said about it. The file the user
 * picked arrives as a `File`; its neighbours never do, so this is the channel
 * that reads them.
 *
 * **The document must be one the user picked, dropped or opened** (#2357). The
 * renderer passes that document's path (which it holds from `getFilePath`, or
 * from the OS open-file door) and the ref's own text. The path is a claim, so
 * the first gate is main's grant registry (`file-grants.ts`): a `specPath` the
 * engine holds no grant for is refused, whatever its extension, before its
 * directory is used for anything. The registry is persisted by the engine's
 * `file_grants` table, so a document picked in an earlier session still
 * reads; one declared before grants existed must be picked once more. The ref
 * is then resolved *in this process*, against the granted document's
 * directory, which is the difference between "read a file this document asked
 * for" and "read a path the web layer composed".
 *
 * The remaining gates are `data-file.ts`'s, for the same reasons stated there:
 *
 *  1. **Extension allowlist** - the three a spec can be written in and nothing
 *     else. It keeps keys, databases and dotfiles out of a *ref*; it does not
 *     keep out a credentials `.json`, which is what the grant and the
 *     containment below are for.
 *  2. **The engine's `maxSpecDocumentBytes`, fetched** - never a second copy of
 *     the rule. The bundle has to fit what `POST /specs` will store, and a user
 *     who raises the setting can import the bigger spec the same session.
 *
 * **A ref may not leave the granted document's directory** (#1782). A spec from
 * the internet can name `../../.config/<tool>/credentials.json`, and the bundle
 * is stored: the file would be inlined into the stored document with no one
 * having chosen it. The rule is containment: the ref, resolved, must sit under
 * `dirname(specPath)`, compared component-wise and again after symlinks are
 * resolved. The siblings it reads are not themselves granted; the document's
 * grant is what reaches them. Siblings of a picked *folder* are served from the
 * batch itself (`importers/batch.ts`) before this channel is asked, so
 * `spec/a.yaml` -> `../shared/b.yaml` still bundles when the folder was picked.
 *
 * Bytes, not text, again matching `dataFile:read`: decoding belongs to one place
 * on the renderer side, so a sibling read here cannot disagree with the picked
 * file read through `FileReader`.
 */

import { promises as fs } from "fs";
import path from "path";

import { SPEC_DOCUMENT_MAX_BYTES_SEED } from "./constants.js";
import { engineOrigin } from "./engine-endpoint.js";
import { engineFetch } from "./engine-fetch.js";
import { assertGranted, type IsGranted } from "./file-grants.js";
import { isWithin } from "./path-within.js";

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
	realpath: (filePath: string) => Promise<string>;
	fetchConfig: () => Promise<unknown>;
	/**
	 * Whether the user picked, dropped or opened this path (`FileGrants.isGranted`).
	 * Required, so a reader wired without the registry fails type-check rather
	 * than reading anything.
	 */
	isGranted: IsGranted;
}

/** The real filesystem and engine, gated by @p isGranted. */
export function createSpecFileSystem(isGranted: IsGranted): SpecFileSystem {
	return {
		stat: (filePath) => fs.stat(filePath),
		readFile: (filePath) => fs.readFile(filePath),
		realpath: (filePath) => fs.realpath(filePath),
		fetchConfig: async () => {
			const response = await engineFetch(`${engineOrigin()}/config`);
			if (!response.ok) throw new Error(`config responded ${response.status}`);
			return await response.json();
		},
		isGranted,
	};
}

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

class OutsideFolderError extends Error {
	constructor(refPath: string) {
		super(
			`"${refPath}" points outside the folder of the spec that names it, so Vayu did not read it. Move the file next to the spec, or import a bundled spec.`
		);
	}
}

/**
 * Read one file referenced by an imported spec, or throw a message the import
 * dialog can show as-is.
 *
 * @param specPath the document the user picked, which must hold a grant; only
 * its directory is used.
 * @param refPath the `$ref` target as the document wrote it, relative to that
 * directory.
 * @throws FileNotGrantedError when @p specPath is not a granted file.
 */
export async function readSpecFile(
	specPath: string,
	refPath: string,
	system: SpecFileSystem
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

	await assertGranted(system.isGranted, specPath);

	const specDir = path.dirname(specPath);
	const resolved = path.resolve(specDir, refPath);
	if (!isWithin(specDir, resolved)) throw new OutsideFolderError(refPath);
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

	// A symlink inside the folder can still point out of it; the lexical check
	// above cannot see that, so both ends are canonicalised and compared again.
	let canonical: string;
	let canonicalDir: string;
	try {
		canonical = await system.realpath(resolved);
		canonicalDir = await system.realpath(specDir);
	} catch {
		throw new Error(`The spec references ${refPath}, which is not at ${resolved}.`);
	}
	if (!isWithin(canonicalDir, canonical)) throw new OutsideFolderError(refPath);

	const maxBytes = await maxSpecFileBytes(system);
	if (size > maxBytes) {
		throw new Error(
			`${refPath} is ${size} bytes, over the ${maxBytes} one document may hold. Raise the maxSpecDocumentBytes engine setting, or split the spec.`
		);
	}

	const buffer = await system.readFile(canonical);
	return {
		bytes: new Uint8Array(buffer),
		fileName: path.basename(resolved),
	};
}
