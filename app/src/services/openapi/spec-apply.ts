/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Turning a spec diff and the user's ticks into the one call that applies them
 * (issue #655, phase 2c of #625).
 *
 * `spec-diff` works out what moved and cannot damage a row; this decides what
 * to *write* and still cannot, because it only builds a payload -
 * `POST /specs/sync` performs it in one transaction. Splitting it this way is
 * what makes the two rules that matter provable without a database:
 *
 * - **A field the user edited is never written unless they ticked it.** The
 *   default selection reads `SpecFieldDiff.userTouched` and leaves those fields
 *   out; a request whose bound document could not be read is left out whole,
 *   because there "the user edited it" is a claim nothing can make.
 * - **Deleting is opt-in.** Added operations and untouched changes are ticked
 *   by default - they only add or restore what the contract says - while a
 *   request whose operation is gone stays until somebody says otherwise.
 *
 * **Applying a change refreshes that request's imported examples.** The diff
 * deliberately does not compare examples (#654), so the rule is stated rather
 * than shown: the document's responses replace the examples a previous import
 * or sync wrote, and an example saved from a live response is never touched -
 * the engine keeps that promise by `origin`, not this payload.
 *
 * **The identity travels with the request, always - and it is `specOperation`,
 * not `method`.** An applied change writes `specOperation` whether or not
 * anything was ticked: an operation *is* its method and path template, so a
 * request that recorded the old identity after a rename would be diffed against
 * the wrong operation next time - the exact failure `operation-match.ts` warns
 * about. `request.method` used to ride along on that reasoning and does not
 * anymore (issue #717): it is what the request *sends*, protects no lookup, and
 * writing it unconditionally silently reverted a user's `GET` -> `HEAD` edit on
 * any applied change. It is now a compared, flaggable, tickable `SpecField`
 * like `url`, which is what an import-written field is owed.
 *
 * A method left unticked therefore leaves `request.method` disagreeing with the
 * `specOperation.method` beside it. That is a state the user chose and it stays
 * visible: the next check compares the two again and offers the field again,
 * where writing it for them would be the silent revert this fixes.
 */

import type {
	Collection,
	DeclaredOperation,
	ResponseSchemaIndex,
	ImportApplyExample,
	SpecOperation,
	SpecSyncCollection,
	SpecSyncCreate,
	SpecSyncRequest,
	SpecSyncUpdate,
} from "@/types";
import { requestFieldsFromDraft } from "@/services/importers/request-payload";
import type { ChangedRequest, SpecDiff, SpecField } from "./spec-diff";
import type { SpecRequestDraft } from "./spec-operations";

/** `GET /pets/{petId}` - how a user recognises an operation, and how one is ticked. */
export function operationKey(operation: SpecOperation): string {
	return `${operation.method.toUpperCase()} ${operation.path}`;
}

/**
 * What the user chose to apply.
 *
 * A changed request is present in `changed` when it is being applied at all,
 * and its value is the fields to take from the document - empty for a request
 * whose only change is the identity, which is a real selection rather than an
 * absence.
 */
export interface SpecApplySelection {
	/** {@link operationKey} of each added operation to create. */
	added: ReadonlySet<string>;
	/** Ids of the requests whose operation is gone, to delete. */
	removed: ReadonlySet<string>;
	changed: ReadonlyMap<string, ReadonlySet<SpecField>>;
}

/**
 * The ticks a user is offered before touching anything: everything the document
 * adds, every field it moved that nobody here had edited, and no deletions.
 *
 * A request the comparison could not make three-way (`previousUnknown` - the
 * bound document is unreadable) is left unticked whole: with no old value to
 * compare against, every field is potentially somebody's edit, and defaulting
 * to overwrite would be the silent destruction this split exists to prevent.
 */
export function defaultSelection(diff: SpecDiff): SpecApplySelection {
	const changed = new Map<string, ReadonlySet<SpecField>>();
	for (const item of diff.changed) {
		if (item.previousUnknown) continue;
		const fields = new Set(
			item.fields.filter((field) => !field.userTouched).map((field) => field.field)
		);
		// A request with nothing safe to write and no moved identity is not a
		// change to offer - ticking it would send an update that writes nothing.
		if (fields.size === 0 && !item.renamed) continue;
		changed.set(item.request.id, fields);
	}
	return {
		added: new Set(diff.added.map((entry) => operationKey(entry.operation))),
		removed: new Set<string>(),
		changed,
	};
}

/**
 * Whether a selection would write any request *rows*.
 *
 * Not "would write anything at all" (issue #717): every apply stores the
 * re-fetched document and moves the binding to it, so an empty selection is a
 * document-level update rather than a no-op. This answers which of the two an
 * apply would be - what the button says it is about to do - and never whether
 * one is worth making.
 */
export function isEmptySelection(selection: SpecApplySelection): boolean {
	return (
		selection.added.size === 0 && selection.removed.size === 0 && selection.changed.size === 0
	);
}

export interface BuildSyncPayloadInput {
	/** The bound collection. Nothing outside its subtree is named in the payload. */
	collectionId: string;
	diff: SpecDiff;
	selection: SpecApplySelection;
	/** The re-fetched document, verbatim - the bytes the engine will hash. */
	content: string;
	/** Where it was re-fetched from, or `null` for a file or a paste. */
	sourceUrl: string | null;
	/**
	 * What the re-fetched document declares (issue #629), stored beside it. The
	 * sync writes a *new* `spec_documents` row, so omitting it would silently
	 * turn coverage off for a collection that had it.
	 */
	operations?: DeclaredOperation[];
	/**
	 * What the re-fetched document declares responses look like (issue #628),
	 * on the same terms as `operations`: the sync writes a new row, so omitting
	 * it would silently turn validation off for a collection that had it.
	 */
	responseSchemas?: ResponseSchemaIndex;
	/** Every stored collection, to find the folder an added operation lands in. */
	collections: readonly Collection[];
}

/**
 * The `POST /specs/sync` body for one selection.
 *
 * Added operations land where an import would have put them - the sub-collection
 * named after the operation's first tag, else the one its path names (issue
 * #710), created here when the bound collection does not have one yet, and the
 * bound collection itself for an operation that gets neither. Matching an
 * existing folder by name rather than creating one per
 * sync is what keeps a collection that has been synced five times shaped like
 * one that was imported once.
 */
export function buildSyncPayload({
	collectionId,
	diff,
	selection,
	content,
	sourceUrl,
	operations,
	responseSchemas,
	collections,
}: BuildSyncPayloadInput): SpecSyncRequest {
	const folders = new FolderResolver(collectionId, collections);

	const create: SpecSyncCreate[] = [];
	for (const entry of diff.added) {
		if (!selection.added.has(operationKey(entry.operation))) continue;
		create.push(createItem(entry, `tmp_req_${create.length}`, folders));
	}

	const update: SpecSyncUpdate[] = [];
	for (const item of diff.changed) {
		const fields = selection.changed.get(item.request.id);
		if (!fields) continue;
		update.push(updateItem(item, fields));
	}

	return {
		collectionId,
		spec: {
			content,
			sourceUrl,
			...(operations && operations.length > 0 ? { operations } : {}),
			...(responseSchemas ? { responseSchemas } : {}),
		},
		collections: folders.created,
		create,
		update,
		// The diff's own order, not the set's: a payload that reorders itself run
		// to run is one nobody can compare two of.
		delete: diff.removed
			.filter((request) => selection.removed.has(request.id))
			.map((request) => request.id),
	};
}

function createItem(
	entry: SpecRequestDraft,
	tempId: string,
	folders: FolderResolver
): SpecSyncCreate {
	const target = folders.resolve(entry.folder);
	return {
		tempId,
		// The same draft-to-payload mapping an import uses, so an operation the
		// document adds becomes the request an import of that document would.
		...requestFieldsFromDraft(entry.draft),
		...target,
	};
}

function updateItem(item: ChangedRequest, fields: ReadonlySet<SpecField>): SpecSyncUpdate {
	const { draft } = item;
	const patch: SpecSyncUpdate = { id: item.request.id };
	if (fields.has("name")) patch.name = draft.name;
	if (fields.has("description")) patch.description = draft.description;
	if (fields.has("method")) patch.method = draft.method;
	if (fields.has("url")) patch.url = draft.url;
	if (fields.has("params")) patch.params = draft.params;
	if (fields.has("headers")) patch.headers = draft.headers;
	if (fields.has("body")) {
		patch.body = draft.body;
		patch.bodyType = draft.body.mode; // the engine never derives this
	}
	// The recorded identity, whether or not anything else was ticked - see the
	// file comment for why this rides along and `request.method` no longer does.
	patch.specOperation = item.operation;
	// Present, `[]` included: an operation whose documented responses were
	// removed must lose the examples the last import wrote for them, and an
	// absent key means "leave every example alone".
	patch.examples = (draft.examples ?? []) as ImportApplyExample[];
	return patch;
}

/**
 * Where an added operation's request goes, and which folders that needs.
 *
 * A folder is created at most once per payload however many operations name it,
 * because the engine writes the payload as-is - two folders called `pets` would
 * both land, and the next sync would then have to choose between them.
 */
class FolderResolver {
	readonly created: SpecSyncCollection[] = [];
	private readonly existing = new Map<string, string>();
	private readonly claimed = new Map<string, string>();

	constructor(
		private readonly rootId: string,
		collections: readonly Collection[]
	) {
		for (const collection of collections) {
			// Direct children only: an import files its folders on the bound
			// collection itself, so a same-named folder two levels down is somebody
			// else's and matching it would move the operation out of the shape the
			// document describes.
			if (collection.parentId !== rootId) continue;
			if (!this.existing.has(collection.name))
				this.existing.set(collection.name, collection.id);
		}
	}

	resolve(folder: string): { collectionId: string } | { collectionTempId: string } {
		if (!folder) return { collectionId: this.rootId };
		const stored = this.existing.get(folder);
		if (stored) return { collectionId: stored };

		const already = this.claimed.get(folder);
		if (already) return { collectionTempId: already };

		const tempId = `tmp_col_${this.created.length}`;
		this.claimed.set(folder, tempId);
		this.created.push({ tempId, name: folder, parentId: this.rootId });
		return { collectionTempId: tempId };
	}
}
