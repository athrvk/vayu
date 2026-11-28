/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Importing several documents in one flow (#666).
 *
 * **Every picked file gets a row.** A drop of a folder's contents, or a multi-select, imports each
 * file and says what became of it; taking the first and saying nothing about the rest would be the
 * silent loss this subsystem refuses everywhere else, where every parser tallies what it could not
 * represent. Batches are also wanted for their own sake: a vendor shipping one spec per service is
 * the norm (PayPal's public API surface is 13 OpenAPI documents in one folder), otherwise 13
 * round-trips through the dialog.
 *
 * **This is a layer above the parsers, not a change to them.** Each document runs the bundle ->
 * detect -> parse pipeline on its own, so a batch may mix formats by construction: detection is per
 * file. What this module adds is the ledger those per-file results live in, and the one thing a
 * batch knows that a single file cannot: a `$ref` to a sibling file may name a document the user
 * *also just picked*.
 *
 * **Siblings come from the batch first.** `bundleExternalRefs` reads a referenced file through the
 * gated `specFile:read` IPC; when that file is already in the batch, its text is right here, and
 * the IPC round-trip would re-read from disk what the picker handed over. A file another document
 * inlined is marked `bundledInto` and excluded from the apply: it is part of that spec, not a
 * collection of its own, and importing it twice is the double import the mark prevents.
 *
 * **Per-file atomicity is the caller's job, and deliberate.** Each entry is applied as its own
 * `POST /import/apply` transaction (see `ImportModal`), so a seventh file the engine refuses cannot
 * roll back six good ones. That is what N manual imports produce; a combined payload would make
 * unrelated files share a failure.
 */

import {
	bundleExternalRefs,
	dirOf,
	joinRelative,
	RefRefusedError,
	type RefReport,
} from "./ref-bundler";
import { parseImport } from "./factory";
import {
	UnrecognisedFormatError,
	type CollectionDraft,
	type ImportOptions,
	type ImportResult,
} from "./types";
import { IMPORT_MCP_TOKEN_VARIABLE } from "@/constants/import";
import type { ImportFetchOptions, ImportMcpDiffMatch, ImportMcpRequest } from "@/types/api";
import type { OAuth2Config } from "@/types";

/**
 * What a folder pick will even look at. A folder is picked wholesale (`webkitdirectory` hands over
 * every file under it, `.git` objects and PNGs included), so this filter keeps the ledger about
 * specs. It is **not** applied to a drop or an explicit multi-select: there the user named the
 * files, and dropping one for its extension would be the silent discard this module exists to
 * remove. Those arrive as an "Unrecognized format" row instead, which says so.
 */
export const IMPORTABLE_EXTENSIONS = [".json", ".yaml", ".yml", ".jmx"] as const;

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
	 * `null` for an entry built from an already-parsed result (`mcpBatchEntry`):
	 * there is no document to re-parse, so `reparseBatch` leaves it alone.
	 */
	raw: string | null;
	/** External `$ref`s nothing could reach, already stamped into `result.meta`. */
	unresolvedRefs: number;
	/** What the bundling fetched and refused, named; carried onto `result.meta.refReport`. */
	refReport?: RefReport;
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
	/**
	 * Indexes into `result.clientCertificates` the user ticked (issue #2363);
	 * absent means none. Per entry, because a batch applies one file at a time and
	 * one file's ticks must never register another's certificates. Cleared when
	 * the file is re-parsed: the candidates it indexes may no longer be the same.
	 */
	selectedCertificates?: number[];
	/** What the apply did with it. Absent until Import has run. */
	outcome?: { ok: boolean; message: string };
	/**
	 * Collections an earlier import of this MCP server built, compared with what the server lists
	 * now (#3842). Only `mcpBatchEntry` sets it; empty or absent means nothing was found or the
	 * comparison failed, and the preview then shows no diff.
	 */
	existingMcp?: ImportMcpDiffMatch[];
	/**
	 * The request the connect sent, which `existingMcp` was computed from (#3994). An update sends
	 * it again, so it writes against the listing the user was shown rather than whatever the form
	 * holds by then. It carries a static bearer token, so it lives and dies with the entry, which
	 * `resetTab` drops when the preview is dismissed or the dialog closes.
	 */
	mcpRequest?: ImportMcpRequest;
	/**
	 * The config an OAuth connect signed in with, as discovery filled it (#3983). Set, `mcpRequest`
	 * carries no token: the access token expires, so an update asks the engine's cache for it again
	 * rather than replaying the one the connect sent.
	 */
	mcpOAuth?: OAuth2Config;
}

/** How the batch reaches files the picked documents reference. */
export interface BatchIntake {
	/** The engine's live `maxSpecDocumentBytes`; a bundle has to fit it. */
	maxBytes: number;
	/** Fetch an absolute URL's text through the engine proxy; `options` marks a `$ref`. */
	fetchUrl: (url: string, options?: ImportFetchOptions) => Promise<string>;
	/**
	 * Read a file beside a picked document, from disk. Absent outside Electron -
	 * in-batch siblings still resolve, because their text never left the picker.
	 */
	readSibling?: (specPath: string, refPath: string) => Promise<string>;
}

/**
 * How far through a batch the work is (#882). Two stages, because they are two different waits:
 * `bundling` follows each document's `$ref`s (disk, or the network), `parsing` is one engine round
 * trip per document. Both totals count real work: `parsing`'s is the documents that will actually
 * be parsed, fewer than those picked whenever one could not be read or was inlined into another,
 * and a total that included those would leave the bar permanently short of itself. File *reads* get
 * no stage: they are local and effectively instant, and a counter for them would be motion without
 * information.
 */
export interface BatchProgress {
	stage: "bundling" | "parsing";
	done: number;
	total: number;
}

/**
 * Report progress, or throw it away for a caller that wants none. A zero total is silence, not a
 * `0 of 0` tick: a stage with no work in it is not a stage, and a bar for it could never move.
 */
function reporter(onProgress?: (progress: BatchProgress) => void) {
	return (stage: BatchProgress["stage"], done: number, total: number): void => {
		if (onProgress && total > 0) onProgress({ stage, done, total });
	};
}

/** A parse or bundle failure, in the words the dialog shows. */
function failureMessage(e: unknown): string {
	// American spelling for the user-facing row (docs/ux-writing.md); the
	// engine's own string this error is matched against (`import_document.cpp`)
	// keeps its British spelling untouched, since that's a comparison key, not
	// UI text (see `factory.ts`'s `UNRECOGNISED`).
	if (e instanceof UnrecognisedFormatError)
		return "Unrecognized format - Vayu reads OpenAPI, Postman, Insomnia and JMeter.";
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

/**
 * What to call one entry on screen. A pasted document has neither a file name nor a URL, and every
 * surface that names an entry (the ledger row, the re-import dialog of #680) has to fall back the
 * same way, or one file is called two things in two places.
 */
export function entryLabel(entry: BatchEntry): string {
	return entry.fileName || entry.sourceUrl || "Pasted document";
}

/**
 * The entry for a result the engine already built from a live MCP server (`POST /import/mcp`,
 * #3843). It has no document: `raw` is `null`, and the server URL stands where a file's name
 * would, so `entryLabel` names it. `existingMcp` is what the diff route found of an earlier
 * import of the same server, and `request` is what both calls were sent.
 *
 * With @p oauth (#3983) the token in `request` came from a sign-in, so the root the engine built
 * around it (bearer `{{mcpToken}}` over an empty secret variable) becomes an OAuth 2.0 root on
 * that sign-in's config, and the kept request drops the token.
 */
export function mcpBatchEntry(
	result: ImportResult,
	request: ImportMcpRequest,
	existingMcp: ImportMcpDiffMatch[] = [],
	oauth?: OAuth2Config
): BatchEntry {
	const { url } = request;
	return {
		id: `mcp:${url}`,
		fileName: "",
		relativePath: "",
		specPath: "",
		sourceUrl: url,
		raw: null,
		unresolvedRefs: 0,
		result: oauth ? withSignedInRoots(result, oauth) : result,
		error: null,
		bundledInto: null,
		included: true,
		existingMcp,
		...(oauth
			? { mcpRequest: withoutAuth(request), mcpOAuth: oauth }
			: { mcpRequest: request }),
	};
}

/**
 * Each root on @p config's OAuth 2.0 sign-in, without the token variable a bearer root reads. The
 * config holds discovered endpoints and a client id, never a token: a run keys the cached token
 * from it and refreshes it headless.
 */
function withSignedInRoots(result: ImportResult, config: OAuth2Config): ImportResult {
	const signedIn = (root: CollectionDraft): CollectionDraft => {
		const { [IMPORT_MCP_TOKEN_VARIABLE]: _token, ...variables } = root.variables;
		return { ...root, auth: { mode: "oauth2", config }, variables };
	};
	return { ...result, collections: result.collections.map(signedIn) };
}

function withoutAuth(request: ImportMcpRequest): ImportMcpRequest {
	const { auth: _auth, ...rest } = request;
	return rest;
}

const NO_REFS: RefReport = { fetched: [], refused: [] };

function hasRefReport(report: RefReport): boolean {
	return report.fetched.length > 0 || report.refused.length > 0;
}

/** A document after bundling, before anything has tried to detect its format. */
interface BundledDocument {
	document: BatchDocument;
	raw: string;
	unresolvedRefs: number;
	refReport: RefReport;
	error?: string;
}

/**
 * Bundle, detect and parse every document in the batch. Two passes, because the first discovers
 * which files are `$ref` targets of another: an entry cannot be labelled a bundled sibling until
 * every document has had its chance to name it, and the document that names it may be picked after
 * it.
 */
export async function detectBatch(
	documents: BatchDocument[],
	opts: ImportOptions,
	intake: BatchIntake,
	onProgress?: (progress: BatchProgress) => void
): Promise<BatchEntry[]> {
	const report = reporter(onProgress);
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

	const bundleOne = async (document: BatchDocument): Promise<BundledDocument> => {
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
						if (siblingKey === ".." || siblingKey.startsWith("../")) {
							throw new RefRefusedError();
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
				refReport: NO_REFS,
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
			return {
				document,
				raw: bundle.text,
				unresolvedRefs: bundle.unresolvedRefs,
				refReport: { fetched: bundle.fetched, refused: bundle.refused },
			};
		} catch (e) {
			// Only the size cap throws; an unreachable ref is counted, not fatal.
			// It is this file's failure and not the batch's - the other twelve
			// specs in the folder have nothing to do with this one's size.
			return {
				document,
				raw: document.text,
				unresolvedRefs: 0,
				refReport: NO_REFS,
				error: failureMessage(e),
			};
		}
	};

	// Opened at zero, so the dialog has a bar before the first document finishes -
	// which is exactly when a slow one leaves it with nothing to say.
	report("bundling", 0, documents.length);
	let bundled = 0;
	const bundles = await Promise.all(
		documents.map(async (document) => {
			const bundle = await bundleOne(document);
			// Ticked as each one lands rather than by walking a queue: the wave
			// stays parallel, and serializing it for a tidier counter would trade a
			// 13-file folder's wall time for a nicer-looking number.
			report("bundling", ++bundled, documents.length);
			return bundle;
		})
	);

	/**
	 * A file another document inlined, or one that could not be read, is never parsed: the first is
	 * a fragment of somebody else's spec and the second has nothing to parse. Decided once, here,
	 * because the parse is a round trip to the engine and the map below has to be synchronous.
	 */
	const skipParse = (bundle: (typeof bundles)[number]): boolean => {
		const key = batchKey(bundle.document);
		return !!bundle.error || !!(key && consumed.get(key));
	};

	// One wave for the whole batch rather than one file at a time: a 13-document
	// folder pick is 13 parses, and sequentially that is 13 round trips.
	//
	// The total is what `skipParse` leaves, not `documents.length`: a file that
	// could not be read, or that another document inlined, is never parsed.
	const parseCount = bundles.filter((bundle) => !skipParse(bundle)).length;
	report("parsing", 0, parseCount);
	let parsedSoFar = 0;
	const parsed = await Promise.all(
		bundles.map(async (bundle) => {
			if (skipParse(bundle)) return null;
			const result = await parseEntry(bundle.raw, opts, {
				...bundle.document,
				unresolvedRefs: bundle.unresolvedRefs,
				refReport: bundle.refReport,
			});
			report("parsing", ++parsedSoFar, parseCount);
			return result;
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
			refReport: bundle.refReport,
		};

		const bundledInto = key ? (consumed.get(key) ?? null) : null;
		if (bundledInto) {
			// Not parsed at all: it is a fragment of somebody else's document, and
			// "Unrecognized format" would be a false accusation against a file that
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
			...(parsed[index] ?? { result: null, error: null, included: false }),
			bundledInto: null,
		};
	});
}

/** Parse one already-bundled document into the half of an entry that can fail. */
async function parseEntry(
	raw: string,
	opts: ImportOptions,
	source: Pick<BatchDocument, "fileName" | "sourceUrl"> & {
		unresolvedRefs?: number;
		refReport?: RefReport;
	}
): Promise<Pick<BatchEntry, "result" | "error" | "included">> {
	try {
		const result = await parseImport(raw, opts, {
			...(source.fileName ? { fileName: source.fileName } : {}),
			...(source.sourceUrl ? { sourceUrl: source.sourceUrl } : {}),
			...(source.unresolvedRefs ? { unresolvedRefs: source.unresolvedRefs } : {}),
		});
		// The engine never saw the bundling, so the named half of it rides on the
		// meta here, where `importNotices` reads it for every surface that shows
		// one file's preview.
		if (source.refReport && hasRefReport(source.refReport)) {
			result.meta.refReport = source.refReport;
		}
		return { result, error: null, included: true };
	} catch (e) {
		return { result: null, error: failureMessage(e), included: false };
	}
}

/**
 * Whether an option toggle has anything to re-parse in this entry. A bundled sibling and an
 * applied entry keep what they have; so does a document-less one (`raw` is `null`): an MCP import
 * carries no scripts or environments for the toggles to act on, and posting nothing to
 * `/import/parse` would only turn a good result into an error.
 */
function isReparsable(entry: BatchEntry): boolean {
	return entry.raw !== null && !entry.bundledInto && !entry.outcome;
}

/**
 * Re-parse a batch after an option toggle, from the text already bundled. Nothing is re-fetched:
 * `raw` is the bundled document and the refs that stayed unresolved still are, so the count is
 * restated, not recomputed; a re-parse that dropped it would quietly un-report a loss the user was
 * already told about. Anything already applied keeps its outcome and stays out of the next apply.
 */
export async function reparseBatch(
	entries: BatchEntry[],
	opts: ImportOptions,
	onProgress?: (progress: BatchProgress) => void
): Promise<BatchEntry[]> {
	const report = reporter(onProgress);
	// A toggle re-parses every entry that has one - the same round trip per file
	// the first parse was - so it reports the same counter rather than looking
	// instant and then blocking for a folder's worth of them.
	const reparses = entries.filter(isReparsable).length;
	report("parsing", 0, reparses);
	let done = 0;
	return await Promise.all(
		entries.map(async (entry) => {
			if (entry.raw === null || !isReparsable(entry)) return entry;
			const parsed = await parseEntry(entry.raw, opts, {
				...(entry.fileName ? { fileName: entry.fileName } : {}),
				...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
				unresolvedRefs: entry.unresolvedRefs,
				refReport: entry.refReport,
			});
			report("parsing", ++done, reparses);
			// A file the user had unchecked stays unchecked; a toggle changes what is
			// in each file, not which files the user asked for. A ticked certificate
			// is not carried over: it indexes the parse that was replaced.
			return {
				...entry,
				...parsed,
				included: parsed.result !== null && entry.included,
				selectedCertificates: [],
			};
		})
	);
}
