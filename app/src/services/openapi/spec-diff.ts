/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a re-fetched OpenAPI document changed about the collection bound to it
 * (issue #654, phase 2b of #625).
 *
 * Binding recorded which operation each request is; this answers the question
 * that identity exists for - **has the contract moved, and where**. Three
 * buckets, the shape #627 fixed: operations with no request (`added`), requests
 * whose operation the document no longer declares (`removed`), and requests
 * whose operation is still there but no longer produces what the collection
 * holds (`changed`).
 *
 * **Nothing here writes.** The diff is a pure function of two documents and the
 * requests, so every judgement it makes - which operation is which, what counts
 * as changed, what the user has edited - is provable in a test that cannot touch
 * a row. Applying it is #655.
 *
 * **Identity, and renames.** An operation is followed by its `operationId`
 * first and by method + path shape second, so the two ways a document commonly
 * moves an operation both stay one operation: a path edited under a stable
 * `operationId` follows the id, an `operationId` edited under a stable path
 * follows the path. Both changed at once is a `removed` and an `added`, stated
 * as such - there is nothing left to follow, and guessing is how a sync
 * overwrites the wrong request. The path side is compared through
 * `specPathShape`, the same flattening `matchOperations` binds with, so a
 * renamed *path parameter* (`{petId}` -> `{id}`) is the same endpoint here too.
 * An id is only followed while it means one thing, though - see {@link lookup}
 * for the two ways a duplicated `operationId` stops it from meaning anything
 * (issue #715).
 *
 * **Changed is measured against what an import would produce**, not against a
 * hand-written idea of the mapping: the drafts come from the same parsers the
 * importer runs, so the collection and the diff can only disagree if the
 * document did.
 *
 * **The user-touched flag is three-way.** A field is flagged when what the
 * request holds is neither what the new document produces nor what the *bound*
 * one did - which is the only evidence that a person put it there. #655 reads
 * the flag as the thing it may not overwrite silently; a two-way comparison
 * cannot tell an edit apart from a spec change and would quietly revert one.
 *
 * **Response examples are deliberately not compared.** It costs a query per
 * request, and the rule that governs them (`origin="import"` is replaced,
 * `origin="user"` survives) only means anything at apply time - so they land
 * with #655 rather than sitting here as a comparison nothing acts on.
 */

import type { KeyValueEntry, Request, RequestBody, SpecOperation } from "@/types";
import type { RequestDraft } from "@/services/importers/types";
import type { SpecRequestDraft } from "./spec-operations";
import { operationShapeKey, specPathShape } from "./operation-match";

/**
 * The fields an OpenAPI import writes, and therefore the only ones a sync has
 * any claim on. `auth` and the scripts are absent on purpose: an import sets
 * auth to `inherit` and the scripts to empty for every operation, so a
 * difference there is always the user's and never the document's.
 */
export type SpecField = "name" | "description" | "url" | "params" | "headers" | "body";

/** Field order for display - the request builder's own top-to-bottom order. */
const FIELDS: readonly SpecField[] = ["name", "description", "url", "params", "headers", "body"];

/** One field of one request that no longer matches the document. */
export interface SpecFieldDiff {
	field: SpecField;
	/** What the request holds today, rendered for display. */
	current: string;
	/** What the re-fetched document produces, rendered for display. */
	next: string;
	/**
	 * The request's value is neither the new document's nor the bound one's -
	 * somebody edited it. False whenever {@link ChangedRequest.previousUnknown}
	 * is set: with no bound value to compare against, "the user did this" is not
	 * a claim this can make.
	 */
	userTouched: boolean;
}

/** How a request was followed from its recorded identity into the new document. */
export type IdentityMatch = "operationId" | "path";

export interface ChangedRequest {
	request: Request;
	/** The identity the request carries today. */
	boundOperation: SpecOperation;
	/** The same operation as the new document declares it. */
	operation: SpecOperation;
	/**
	 * The request an import of the new document would build for this operation -
	 * the values behind {@link SpecFieldDiff.next} (issue #655).
	 *
	 * Kept because applying a change has to write *values*, and the rendered
	 * `next` is truncated for display. Reading them from the same draft the
	 * comparison was made against is what stops the diff and the apply from
	 * disagreeing about what the document says.
	 */
	draft: RequestDraft;
	matchedBy: IdentityMatch;
	/** The document moved the identity itself - the other half of it changed. */
	renamed: boolean;
	/** Every field that no longer matches, in display order. May be empty for a pure rename. */
	fields: SpecFieldDiff[];
	/**
	 * The bound document does not declare this operation (or could not be read),
	 * so what the user edited cannot be told apart from what the document
	 * changed. Stated rather than guessed at.
	 */
	previousUnknown: boolean;
}

export interface SpecDiff {
	/** Operations no request claims. These become requests in #655, not here. */
	added: SpecRequestDraft[];
	/** Requests whose recorded operation the new document no longer declares. */
	removed: Request[];
	changed: ChangedRequest[];
	/** Requests whose operation is unchanged in every compared field. */
	unchanged: number;
	/**
	 * Requests carrying no operation identity at all. Not part of the comparison
	 * - the contract never described them - but counted, because a sync that
	 * silently ignores half a collection is a sync nobody can read.
	 */
	unmapped: number;
}

export interface SpecDiffInput {
	/**
	 * The document the collection is bound to, as drafts. `null` when it could
	 * not be read at all, which turns every field comparison two-way and sets
	 * `previousUnknown`.
	 */
	bound: readonly SpecRequestDraft[] | null;
	/** The re-fetched document, as drafts. */
	fetched: readonly SpecRequestDraft[];
	/** Every request beneath the bound collection. */
	requests: readonly Request[];
}

export function diffSpec({ bound, fetched, requests }: SpecDiffInput): SpecDiff {
	const fetchedIndex = index(fetched);
	const boundIndex = bound ? index(bound) : null;
	const ambiguousIds = idsMoreThanOneRequestClaims(requests);

	const added: SpecRequestDraft[] = [];
	const removed: Request[] = [];
	const changed: ChangedRequest[] = [];
	let unchanged = 0;
	let unmapped = 0;

	const claimed = new Set<SpecRequestDraft>();

	for (const request of requests) {
		const boundOperation = request.specOperation;
		if (!boundOperation) {
			unmapped += 1;
			continue;
		}

		const found = lookup(fetchedIndex, boundOperation, ambiguousIds);
		if (!found) {
			removed.push(request);
			continue;
		}
		claimed.add(found.entry);

		const previous = boundIndex
			? lookup(boundIndex, boundOperation, ambiguousIds)?.entry
			: undefined;
		const fields = diffFields(request, found.entry.draft, previous?.draft);
		const renamed = !sameOperation(boundOperation, found.entry.operation);
		if (fields.length === 0 && !renamed) {
			unchanged += 1;
			continue;
		}
		changed.push({
			request,
			boundOperation,
			operation: found.entry.operation,
			draft: found.entry.draft,
			matchedBy: found.matchedBy,
			renamed,
			fields,
			previousUnknown: !previous,
		});
	}

	for (const entry of fetched) {
		if (!claimed.has(entry)) added.push(entry);
	}

	return { added, removed, changed, unchanged, unmapped };
}

interface OperationIndex {
	byOperationId: Map<string, SpecRequestDraft>;
	byPath: Map<string, SpecRequestDraft>;
}

/**
 * Both keys for every operation, first declaration winning.
 *
 * First rather than last because a document that declares one `operationId`
 * twice is already invalid, and the duplicate then falls out as an `added`
 * operation - visible, rather than silently displacing the one a request is
 * bound to. The drafts arrive from the import parsers, which drop a repeated id
 * rather than stamping it twice (issue #715), so the second declaration reaches
 * this with a method-and-path identity and is indexed by path alone.
 */
function index(entries: readonly SpecRequestDraft[]): OperationIndex {
	const byOperationId = new Map<string, SpecRequestDraft>();
	const byPath = new Map<string, SpecRequestDraft>();
	for (const entry of entries) {
		const { operationId } = entry.operation;
		if (operationId && !byOperationId.has(operationId)) byOperationId.set(operationId, entry);
		const key = pathKey(entry.operation);
		if (!byPath.has(key)) byPath.set(key, entry);
	}
	return { byOperationId, byPath };
}

/**
 * The `operationId`s more than one request in this collection records - the
 * shape a document that declared one id twice left behind (issue #715).
 *
 * Import no longer stamps a repeated id at all, but a collection imported
 * before that fix still holds two requests claiming one id, and an id two
 * requests claim identifies neither of them. They are followed by path here,
 * which is the same refusal-to-guess `operation-match.ts` binds by.
 */
function idsMoreThanOneRequestClaims(requests: readonly Request[]): ReadonlySet<string> {
	const seen = new Set<string>();
	const repeated = new Set<string>();
	for (const request of requests) {
		const id = request.specOperation?.operationId;
		if (!id) continue;
		if (seen.has(id)) repeated.add(id);
		else seen.add(id);
	}
	return repeated;
}

/**
 * The document's entry for one recorded identity, and how it was found.
 *
 * The `operationId` leads - that is what follows an operation whose path moved
 * - with two limits, both of them cases where following it would pair a request
 * with an operation that contradicts what the request says it is (issue #715):
 *
 * - an id **two requests claim** identifies neither, so it is skipped entirely;
 * - an id whose entry has a different method + path shape loses to an **exact
 *   match on the request's own** method + path, because a document still
 *   declaring the endpoint the request records is a stronger statement about
 *   which operation this is than an id pointing somewhere else. With no exact
 *   match the id is still followed: that is the ordinary rename, where the
 *   document moved the path and the id is all there is left to follow.
 */
function lookup(
	spec: OperationIndex,
	operation: SpecOperation,
	ambiguousIds: ReadonlySet<string>
): { entry: SpecRequestDraft; matchedBy: IdentityMatch } | undefined {
	const byPath = spec.byPath.get(pathKey(operation));
	const { operationId } = operation;
	if (operationId && !ambiguousIds.has(operationId)) {
		const byId = spec.byOperationId.get(operationId);
		if (byId && (!byPath || pathKey(byId.operation) === pathKey(operation)))
			return { entry: byId, matchedBy: "operationId" };
	}
	return byPath ? { entry: byPath, matchedBy: "path" } : undefined;
}

function pathKey(operation: SpecOperation): string {
	return operationShapeKey(operation.method, specPathShape(operation.path));
}

/**
 * Whether the recorded identity is still exactly what the document declares.
 *
 * Compared as *written*, not as shaped: `{petId}` -> `{id}` is the same endpoint
 * to `lookup` - which is what keeps the request attached to its operation - but
 * it is a different `spec_operation` to store, and telling #655 the identity is
 * unchanged would leave the collection recording a path the document no longer
 * uses.
 */
function sameOperation(a: SpecOperation, b: SpecOperation): boolean {
	return (
		(a.operationId ?? "") === (b.operationId ?? "") &&
		a.method.toUpperCase() === b.method.toUpperCase() &&
		a.path === b.path
	);
}

/**
 * Everything the request holds that the document no longer produces.
 *
 * A field is reported when the request does not match the new document -
 * "differs from what a fresh import would produce", #627's definition - and
 * flagged when it does not match the bound document either. Those two questions
 * are separate on purpose: the first is what a sync would change, the second is
 * whether changing it would destroy somebody's work.
 */
function diffFields(
	request: Request,
	next: RequestDraft,
	previous: RequestDraft | undefined
): SpecFieldDiff[] {
	const current = fieldValues(request);
	const nextValues = fieldValues(next);
	const previousValues = previous ? fieldValues(previous) : undefined;

	const out: SpecFieldDiff[] = [];
	for (const field of FIELDS) {
		if (current[field].compare === nextValues[field].compare) continue;
		out.push({
			field,
			current: current[field].display,
			next: nextValues[field].display,
			userTouched: previousValues
				? current[field].compare !== previousValues[field].compare
				: false,
		});
	}
	return out;
}

/** The one value each field is compared by, and the one shown for it. */
interface FieldValue {
	compare: string;
	display: string;
}

/**
 * The spec-derived half of a request, from either side.
 *
 * A `Request` off the engine and a `RequestDraft` off the parsers both satisfy
 * this, which is what lets one function speak for both - the alternative being
 * two renderers that can disagree about whether a field moved.
 */
interface SpecShaped {
	name: string;
	description: string;
	url: string;
	params: KeyValueEntry[];
	headers: KeyValueEntry[];
	body: RequestBody;
}

function fieldValues(source: SpecShaped): Record<SpecField, FieldValue> {
	return {
		name: text(source.name),
		description: text(source.description),
		url: text(source.url),
		params: rows(source.params),
		headers: rows(source.headers),
		body: body(source.body),
	};
}

/** Long enough to recognise a value by, short enough to sit in a list row. */
const DISPLAY_MAX = 120;

function text(value: string | undefined): FieldValue {
	const full = value ?? "";
	return { compare: full, display: truncate(full) };
}

/**
 * Key/value rows, compared and shown as one line.
 *
 * The row count leads so that two lists of different lengths can never render
 * to the same string however their values are punctuated - a collision here
 * would be a change the diff failed to see, which is the one failure this must
 * not have. `description` is part of it because a document that re-words what a
 * parameter means has changed the row Vayu shows.
 */
function rows(entries: readonly (KeyValueEntry & { type?: string })[] | undefined): FieldValue {
	const list = entries ?? [];
	const rendered = list.map((entry) => {
		const pair = entry.value ? `${entry.key}=${entry.value}` : entry.key;
		const described = entry.description ? `${pair} (${entry.description})` : pair;
		// A multipart part the document declares as an upload is a different row
		// from a text one even when both are empty, which is exactly the state an
		// imported file part is in (issue #425).
		const typed = entry.type === "file" ? `${described} [file]` : described;
		return entry.enabled ? typed : `${typed} [off]`;
	});
	const full = `${list.length}: ${rendered.join(", ")}`;
	return { compare: full, display: list.length === 0 ? "none" : truncate(full) };
}

function body(value: RequestBody | undefined): FieldValue {
	if (!value || value.mode === "none") return { compare: "none", display: "none" };
	if (value.mode === "form-data" || value.mode === "x-www-form-urlencoded") {
		const fields = rows(value.fields);
		return {
			compare: `${value.mode} ${fields.compare}`,
			display: `${value.mode}: ${fields.display}`,
		};
	}
	const { content } = value;
	return {
		compare: `${value.mode} ${content}`,
		// The mode leads because a body's first 120 characters are frequently
		// identical between two different stubs (`{`, two keys, a newline).
		display: `${value.mode}: ${truncate(content)}`,
	};
}

function truncate(value: string): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length > DISPLAY_MAX ? `${collapsed.slice(0, DISPLAY_MAX)}…` : collapsed;
}
