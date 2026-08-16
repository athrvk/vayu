/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Importing several documents in one flow (issue #666).
 *
 * **The defect this closes.** The import dialog read `dataTransfer.files[0]` and
 * its `<input type="file">` carried no `multiple`, so a user who dropped a
 * folder's contents got the first file and **no word at all** about the rest.
 * Silent loss is the failure mode this subsystem refuses everywhere else - every
 * parser tallies what it could not represent - so the drop path was a bug on its
 * own terms, independent of whether batches were ever wanted.
 *
 * And they are wanted: a vendor shipping one spec per service is the norm
 * (PayPal's public API surface is 13 OpenAPI documents in one folder), which
 * before this meant 13 round-trips through the dialog.
 *
 * **This is a layer above the parsers, not a change to them.** Each document
 * still runs the existing bundle -> detect -> parse pipeline on its own, so a
 * batch may mix formats by construction: detection is per file and already
 * decides. What this module adds is the ledger those per-file results live in,
 * and the one thing a batch knows that a single file cannot - that a `$ref` to
 * a sibling file may name a document the user *also just picked*.
 *
 * **Siblings come from the batch first.** `bundleExternalRefs` reads a
 * referenced file through the gated `specFile:read` IPC; when the referenced
 * file is already in the batch, its text is right here and the IPC round-trip
 * would re-read from disk what the picker handed over. A file that another
 * document inlined is then marked `bundledInto` and excluded from the apply -
 * it is part of that spec, not a collection of its own, and importing it twice
 * is exactly the double-import the mark prevents.
 *
 * **Per-file atomicity is the caller's job, and deliberate.** Each entry is
 * applied as its own `POST /import/apply` transaction (see `ImportModal`), so a
 * seventh file the engine refuses cannot roll back six good ones. That is what N
 * manual imports already produce; a combined payload would make unrelated files
 * share a failure.
 */

import { bundleExternalRefs, dirOf, joinRelative } from "./ref-bundler";
import { parseImport } from "./factory";
import { UnrecognisedFormatError, type ImportOptions, type ImportResult } from "./types";

/**
 * What a folder pick will even look at.
 *
 * A folder is picked wholesale - `webkitdirectory` hands over every file under
 * it, `.git` objects and PNGs included - so this filter is what keeps the ledger
 * about specs. It is **not** applied to a drop or an explicit multi-select:
 * there the user named the files, and dropping one for its extension would be
 * the silent discard this whole change exists to remove. Those arrive as an
 * "Unrecognised format" row instead, which says so.
 */
export const IMPORTABLE_EXTENSIONS = [".json", ".yaml", ".yml"] as const;

export function isImportableFileName(fileName: string): boolean {
	const lower = fileName.toLowerCase();
	return IMPORTABLE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** One document handed to the batch, before anything has looked at it. */
export interface BatchDocument {
	/** Display name. Absent for a pasted document, which has none. */
	fileName?: string;
	/**
	 * Where this file sits inside the picked set, so a `$ref` between two of them
	 * resolves. A folder pick supplies it (`webkitRelativePath`); a flat drop has
	 * only file names, which is the same thing for files in one directory.
	 */
	relativePath?: string;
	/** Absolute machine-local path. `""` outside Electron, and never sent anywhere. */
	specPath?: string;
	/** Where the text was fetched from, for a URL import. */
	sourceUrl?: string;
	text: string;
	/**
	 * The file could not be read at all - a directory in a drop, a file that
	 * moved between the pick and the read. It still gets a row: a picked file
	 * that produces no row anywhere is the silent discard this module removes.
	 */
	readError?: string;
}

/** One row of the batch ledger: a file, and what the import pipeline made of it. */
export interface BatchEntry {
	/** Stable identity for the render and for the apply, unique within a batch. */
	id: string;
	fileName: string;
	relativePath: string;
	specPath: string;
	sourceUrl: string;
	/**
	 * The bundled text - what was parsed, and what an option toggle re-parses.
	 * Identical to the file's own bytes unless it referenced other documents.
	 */
	raw: string;
	/** External `$ref`s nothing could reach, already stamped into `result.meta`. */
	unresolvedRefs: number;
	result: ImportResult | null;
	/** Why this file cannot be imported, in words. Never set alongside `result`. */
	error: string | null;
	/**
	 * The document that inlined this file as a `$ref` target. Such a file is part
	 * of that spec rather than an import of its own, so it is listed - a picked
	 * file is never dropped in silence - and never applied.
	 */
	bundledInto: string | null;
	/** Included in the apply. Errors and bundled siblings start out excluded. */
	included: boolean;
	/** What the apply did with it. Absent until Import has run. */
	outcome?: { ok: boolean; message: string };
}

/** How the batch reaches files the picked documents reference. */
export interface BatchIntake {
	/** The engine's live `maxSpecDocumentBytes`; a bundle has to fit it. */
	maxBytes: number;
	/** Fetch an absolute URL's text through the engine proxy. */
	fetchUrl: (url: string) => Promise<string>;
	/**
	 * Read a file beside a picked document, from disk. Absent outside Electron -
	 * in-batch siblings still resolve, because their text never left the picker.
	 */
	readSibling?: (specPath: string, refPath: string) => Promise<string>;
}

/** A parse or bundle failure, in the words the dialog shows. */
function failureMessage(e: unknown): string {
	if (e instanceof UnrecognisedFormatError) return "Unrecognised format";
	return (e as Error).message;
}

/** The key a document is known by inside the batch, normalized once. */
function batchKey(document: BatchDocument): string {
	return joinRelative("", document.relativePath ?? document.fileName ?? "");
}

/**
 * Nothing to create: every option is off, or the file carried only things this
 * import is not taking. Distinct from an error - the file parsed, it just has no
 * work in it - and the reason Import stays disabled for a single such file.
 */
export function isEmptyResult(result: ImportResult): boolean {
	return (
		result.collections.length === 0 &&
		result.environments.length === 0 &&
		Object.keys(result.globals).length === 0
	);
}

/** Entries this apply would actually send: included, parsed, and non-empty. */
export function applicableEntries(entries: BatchEntry[]): BatchEntry[] {
	return entries.filter((e) => e.included && e.result && !isEmptyResult(e.result));
}

/** A document after bundling, before anything has tried to detect its format. */
interface BundledDocument {
	document: BatchDocument;
	raw: string;
	unresolvedRefs: number;
	error?: string;
}

/**
 * Bundle, detect and parse every document in the batch.
 *
 * Two passes rather than one, because the first pass is what discovers which
 * files are `$ref` targets of another: an entry cannot be labelled a bundled
 * sibling until every document has had its chance to name it, and the document
 * that names it may be picked after it.
 */
export async function detectBatch(
	documents: BatchDocument[],
	opts: ImportOptions,
	intake: BatchIntake
): Promise<BatchEntry[]> {
	const inBatch = new Map<string, string>();
	for (const document of documents) {
		if (document.readError) continue;
		const key = batchKey(document);
		// First writer wins: two files cannot share a path within one pick, so a
		// collision only happens for unnamed documents (a paste), which reference
		// nothing anyway.
		if (key && !inBatch.has(key)) inBatch.set(key, document.text);
	}

	/** Batch keys some other document inlined, to the file that inlined it. */
	const consumed = new Map<string, string>();

	const bundles = await Promise.all(
		documents.map(async (document): Promise<BundledDocument> => {
			const key = batchKey(document);
			const dir = dirOf(key);
			const specPath = document.specPath ?? "";
			const readSibling =
				key || specPath
					? async (refPath: string): Promise<string> => {
							const siblingKey = joinRelative(dir, refPath);
							const inBatchText = inBatch.get(siblingKey);
							if (inBatchText !== undefined) {
								// Only once it is known to have been used - a lookup that
								// missed must not mark a file as somebody's sibling.
								consumed.set(siblingKey, document.fileName ?? siblingKey);
								return inBatchText;
							}
							if (!specPath || !intake.readSibling) {
								throw new Error(`No file at ${refPath}`);
							}
							return intake.readSibling(specPath, refPath);
						}
					: undefined;

			if (document.readError) {
				return {
					document,
					raw: document.text,
					unresolvedRefs: 0,
					error: document.readError,
				};
			}
			try {
				const bundle = await bundleExternalRefs(document.text, {
					maxBytes: intake.maxBytes,
					...(document.sourceUrl ? { sourceUrl: document.sourceUrl } : {}),
					fetchUrl: intake.fetchUrl,
					...(readSibling ? { readSibling } : {}),
				});
				return { document, raw: bundle.text, unresolvedRefs: bundle.unresolvedRefs };
			} catch (e) {
				// Only the size cap throws; an unreachable ref is counted, not fatal.
				// It is this file's failure and not the batch's - the other twelve
				// specs in the folder have nothing to do with this one's size.
				return {
					document,
					raw: document.text,
					unresolvedRefs: 0,
					error: failureMessage(e),
				};
			}
		})
	);

	return bundles.map((bundle, index) => {
		const { document } = bundle;
		const key = batchKey(document);
		const fileName = document.fileName ?? "";
		const base: Omit<BatchEntry, "result" | "error" | "bundledInto" | "included"> = {
			id: `${index}:${key || fileName || "document"}`,
			fileName,
			relativePath: key,
			specPath: document.specPath ?? "",
			sourceUrl: document.sourceUrl ?? "",
			raw: bundle.raw,
			unresolvedRefs: bundle.unresolvedRefs,
		};

		const bundledInto = key ? (consumed.get(key) ?? null) : null;
		if (bundledInto) {
			// Not parsed at all: it is a fragment of somebody else's document, and
			// "Unrecognised format" would be a false accusation against a file that
			// imported perfectly well - as part of the spec that named it.
			return { ...base, result: null, error: null, bundledInto, included: false };
		}
		if (bundle.error) {
			return {
				...base,
				result: null,
				error: bundle.error,
				bundledInto: null,
				included: false,
			};
		}
		return {
			...base,
			// The count travels into the parse, which is the only place that can
			// stamp it into `meta.skipped` - bundling runs before detection, so no
			// parser can know it, and a count nothing reads is a loss the preview
			// never names.
			...parseEntry(bundle.raw, opts, { ...document, unresolvedRefs: bundle.unresolvedRefs }),
			bundledInto: null,
		};
	});
}

/** Parse one already-bundled document into the half of an entry that can fail. */
function parseEntry(
	raw: string,
	opts: ImportOptions,
	source: Pick<BatchDocument, "fileName" | "sourceUrl"> & { unresolvedRefs?: number }
): Pick<BatchEntry, "result" | "error" | "included"> {
	try {
		const result = parseImport(raw, opts, {
			...(source.fileName ? { fileName: source.fileName } : {}),
			...(source.sourceUrl ? { sourceUrl: source.sourceUrl } : {}),
			...(source.unresolvedRefs ? { unresolvedRefs: source.unresolvedRefs } : {}),
		});
		return { result, error: null, included: true };
	} catch (e) {
		return { result: null, error: failureMessage(e), included: false };
	}
}

/**
 * Re-parse a batch after an option toggle, from the text already bundled.
 *
 * Nothing is re-fetched: `raw` is the bundled document, and the refs that stayed
 * unresolved are still unresolved, so the count is restated rather than
 * recomputed - a re-parse that dropped it would quietly un-report a loss the
 * user was already told about. Anything already applied keeps its outcome and
 * stays out of the next apply.
 */
export function reparseBatch(entries: BatchEntry[], opts: ImportOptions): BatchEntry[] {
	return entries.map((entry) => {
		if (entry.bundledInto || entry.outcome) return entry;
		const parsed = parseEntry(entry.raw, opts, {
			...(entry.fileName ? { fileName: entry.fileName } : {}),
			...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
			unresolvedRefs: entry.unresolvedRefs,
		});
		// A file the user had unchecked stays unchecked; a toggle changes what is
		// in each file, not which files the user asked for.
		return { ...entry, ...parsed, included: parsed.result !== null && entry.included };
	});
}
