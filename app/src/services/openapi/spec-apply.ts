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
 * The comparison is the engine's since issue #854 (`POST /specs/diff`), and
 * since issue #871 so is the *selection* - which of a diff a sync writes when
 * nobody has ticked anything. This file builds the payload for the ticks a user
 * actually made; it no longer decides what those ticks start as.
 *
 * That move is the whole point of the split now. The two rules that matter -
 *
 * - **a field the user edited is never written unless they ticked it**, and
 * - **deleting is opt-in** -
 *
 * are the ones whose silent failure destroys somebody's work, and they used to
 * live here alone. `electron/` may not import `src/` (see the MCP doc), so
 * every caller that was not the Spec tab either went without an apply or copied
 * them, and a copy of a rule like that is a second opinion about which of a
 * user's fields a sync may overwrite. They are now `core::safe_spec_apply` in
 * the engine, reported per entry on the diff (`safe`, `safeFields`) and applied
 * by `POST /specs/sync`'s `policy: "safe"`. {@link defaultSelection} reads that
 * answer; it does not re-derive it.
 *
 * What is still this file's is the payload for a *changed* selection - a user
 * who unticked a field, or ticked a deletion. Those are choices a person made,
 * which no policy can state for them.
 *
 * **Applying a change refreshes that request's imported examples.** The diff
 * deliberately does not compare examples (#654), so the rule is stated rather
 * than shown: the document's responses replace the examples a previous import
 * or sync wrote, and an example saved from a live response is never touched -
 * the engine keeps that promise by `origin`, not this payload. Since issue #869
 * the *rows* are the engine's too: this sends the decision (`examples: true`)
 * and the engine writes what the document it is storing documents. What rode
 * here before was that same answer, carried from the diff two calls earlier and
 * handed back - a round trip that let a payload state examples for a response no
 * document describes.
 *
 * **The identity travels with the request, always - and it is `specOperation`,
 * not `method`.** An applied change writes `specOperation` whether or not
 * anything was ticked: an operation *is* its method and path template, so a
 * request that recorded the old identity after a rename would be diffed against
 * the wrong operation next time - the exact failure the engine's matcher
 * (`core/operation_match.hpp`) warns about. `request.method` used to ride along
 * on that reasoning and does not anymore (issue #717): it is what the request
 * *sends*, protects no lookup, and writing it unconditionally silently reverted
 * a user's `GET` -> `HEAD` edit on any applied change. It is now a compared,
 * flaggable, tickable `SpecField` like `url`, which is what an import-written
 * field is owed.
 *
 * A method left unticked therefore leaves `request.method` disagreeing with the
 * `specOperation.method` beside it. That is a state the user chose and it stays
 * visible: the next check compares the two again and offers the field again,
 * where writing it for them would be the silent revert this fixes.
 */

import type {
	Collection,
	HttpMethod,
	SpecDiffAdded,
	SpecDiffChanged,
	SpecDiffResponse,
	SpecField,
	SpecOperation,
	SpecSyncCollection,
	SpecSyncCreate,
	SpecSyncRequest,
	SpecSyncUpdate,
} from "@/types";
import { requestFieldsFromDraft } from "@/services/importers/request-payload";
import type { RequestDraft } from "@/services/importers/types";

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
 * The ticks a user is offered before touching anything, as the engine states
 * them (issue #871).
 *
 * A reader of `safe` / `safeFields`, not a second author of them: what those
 * mean - everything the document adds, every field it moved that nobody here
 * had edited, no deletions, and a request the comparison could not make
 * three-way left alone whole - is `core::safe_spec_apply`, the same answer
 * `POST /specs/sync`'s `policy: "safe"` applies. An agent syncing over MCP and
 * a person clicking Apply without changing a tick therefore write the same
 * rows, because there is one function deciding it rather than two that agree
 * today.
 */
export function defaultSelection(diff: SpecDiffResponse): SpecApplySelection {
	const changed = new Map<string, ReadonlySet<SpecField>>();
	for (const item of diff.changed) {
		if (!item.safe) continue;
		changed.set(item.requestId, new Set(item.safeFields));
	}
	return {
		added: new Set(
			diff.added.filter((entry) => entry.safe).map((entry) => operationKey(entry.operation))
		),
		removed: new Set(
			diff.removed.filter((entry) => entry.safe).map((entry) => entry.requestId)
		),
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
	diff: SpecDiffResponse;
	selection: SpecApplySelection;
	/** The re-fetched document, verbatim - the bytes the engine will hash. */
	content: string;
	/** Where it was re-fetched from, or `null` for a file or a paste. */
	sourceUrl: string | null;
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
		const fields = selection.changed.get(item.requestId);
		if (!fields) continue;
		update.push(updateItem(item, fields));
	}

	return {
		collectionId,
		spec: {
			content,
			sourceUrl,
		},
		collections: folders.created,
		create,
		update,
		// The diff's own order, not the set's: a payload that reorders itself run
		// to run is one nobody can compare two of.
		delete: diff.removed
			.filter((entry) => selection.removed.has(entry.requestId))
			.map((entry) => entry.requestId),
	};
}

/**
 * An added operation's draft as the import pipeline's own shape.
 *
 * The three constants an OpenAPI import writes for every operation it builds -
 * `inherit` auth and two empty scripts - are stated here because the engine's
 * draft deliberately omits them: they are the same value for every operation of
 * every document, so a comparison would never report one and carrying them
 * across the wire per operation would be bytes nothing reads.
 *
 * The point of assembling one is `requestFieldsFromDraft`: an operation the
 * document adds must become the request an import of that document would, and
 * one mapping for both paths is what makes that structural rather than
 * remembered.
 */
function draftOf(entry: SpecDiffAdded): RequestDraft {
	// The documented responses are dropped rather than carried: a sync writes the
	// examples the document it stores documents (issue #869), so a created
	// request's rows come off that document and `examples` in the payload is a
	// `400`. They stay on the diff's answer because that is a preview of what an
	// apply will write.
	const { examples: _documented, ...rest } = entry.draft;
	return {
		...rest,
		method: entry.draft.method as HttpMethod,
		auth: { mode: "inherit" },
		preRequestScript: "",
		postRequestScript: "",
		specOperation: entry.operation,
	};
}

function createItem(entry: SpecDiffAdded, tempId: string, folders: FolderResolver): SpecSyncCreate {
	const target = folders.resolve(entry.folder);
	return {
		tempId,
		// The same draft-to-payload mapping an import uses, so an operation the
		// document adds becomes the request an import of that document would.
		...requestFieldsFromDraft(draftOf(entry)),
		...target,
	};
}

function updateItem(item: SpecDiffChanged, fields: ReadonlySet<SpecField>): SpecSyncUpdate {
	const { draft } = item;
	const patch: SpecSyncUpdate = { id: item.requestId };
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
	// True on every applied change, which is the rule this file has always
	// followed: applying anything to a request refreshes the examples the
	// document wrote for it. The engine reads the rows off the document being
	// stored - including the empty answer for an operation whose responses were
	// removed, which is what makes the last import's examples go. Absent would
	// mean "leave every example alone", and no applied change means that.
	patch.examples = true;
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
