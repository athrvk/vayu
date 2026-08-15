/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Reading a bound OpenAPI document again from wherever it came from (issue
 * #654).
 *
 * Binding stored two different kinds of origin, and they are not
 * interchangeable: a URL is portable and travels with the document
 * (`spec_documents.source_url`), while a picked file's path is true of one
 * machine and lives in `spec-file-store`. A collection bound from a paste, or
 * bound on somebody else's machine from a file, has neither - and that is a
 * state to *say*, not to paper over: there is nothing to compare against, and
 * pretending otherwise would report a spec as unchanged because it was never
 * looked at.
 *
 * What comes back goes through the bundler on the way, exactly as import does.
 * The stored document is the bundled one (issue #649), so a comparison against
 * an unbundled re-fetch would report every external `$ref` as a change, on
 * every check, forever.
 *
 * The I/O is injected rather than imported: this module decides *what* to read
 * and in what order, and the renderer decides how - which is what lets the
 * order and the honesty be tested without a network, a disk or Electron.
 */

import { bundleExternalRefs } from "@/services/importers/ref-bundler";

/** Where the bound document came from, as the binding recorded it. */
export interface SpecSource {
	/** `spec_documents.source_url` - portable, and what a re-fetch prefers. */
	sourceUrl?: string | null;
	/** This machine's copy of the picked file, from `spec-file-store`. */
	file?: { path: string; fileName: string };
}

/** How this reaches a URL, a sibling file, and the engine's document cap. */
export interface SpecRefetchIo {
	/** The engine's live `maxSpecDocumentBytes`, for the bundle. */
	maxBytes: number;
	/** Fetch an absolute URL's text through the engine proxy. */
	fetchUrl: (url: string) => Promise<string>;
	/**
	 * Read a file beside a picked document - the `specFile:read` gate. Absent
	 * outside Electron, which is also the case where a file-sourced spec cannot
	 * be re-read at all.
	 */
	readSpecFile?: (specPath: string, refPath: string) => Promise<{ bytes: Uint8Array }>;
}

export interface RefetchedSpec {
	/** The document, bundled - the same text an import would have stored. */
	text: string;
	/** Refs the bundler could not reach, for the same disclosure import makes. */
	unresolvedRefs: number;
}

/**
 * A binding with nothing to re-read: pasted, or picked on another machine.
 *
 * Its own error because the answer is a different one - not "the fetch failed",
 * which invites a retry that cannot work, but "pick the file again", which is
 * the only thing that helps.
 */
export class NoSpecSourceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NoSpecSourceError";
	}
}

export async function refetchSpec(source: SpecSource, io: SpecRefetchIo): Promise<RefetchedSpec> {
	const { text, sourceUrl, specPath } = await read(source, io);
	const readSpecFile = io.readSpecFile;

	// UTF-8 both ways: the file intake decodes bytes here for the same reason
	// `ImportModal` does - one decoder, so a sibling read cannot disagree with
	// the document it sits beside.
	const bundle = await bundleExternalRefs(text, {
		maxBytes: io.maxBytes,
		...(sourceUrl ? { sourceUrl } : {}),
		fetchUrl: io.fetchUrl,
		...(specPath && readSpecFile
			? {
					readSibling: async (relativePath) => {
						const { bytes } = await readSpecFile(specPath, relativePath);
						return new TextDecoder("utf-8").decode(bytes);
					},
				}
			: {}),
	});

	return { text: bundle.text, unresolvedRefs: bundle.unresolvedRefs };
}

async function read(
	source: SpecSource,
	io: SpecRefetchIo
): Promise<{ text: string; sourceUrl?: string; specPath?: string }> {
	if (source.sourceUrl) {
		return { text: await io.fetchUrl(source.sourceUrl), sourceUrl: source.sourceUrl };
	}
	if (source.file?.path && io.readSpecFile) {
		// The document is read through the same gate its siblings are, by naming
		// itself as the file beside itself: the main process resolves a name
		// against the picked path's directory, and the picked file's own name
		// resolves back to the picked file. One gated channel rather than a
		// second one that would have to repeat the extension allowlist and the
		// byte cap - and repeat them identically forever.
		const { bytes } = await io.readSpecFile(source.file.path, source.file.fileName);
		return { text: new TextDecoder("utf-8").decode(bytes), specPath: source.file.path };
	}
	throw new NoSpecSourceError(
		source.file?.path
			? "This document was picked from a file, and files can only be re-read in the desktop app."
			: "This collection's document has no URL and no file on this machine, so there is nothing to re-read. Bind it again from the file or URL it came from."
	);
}
