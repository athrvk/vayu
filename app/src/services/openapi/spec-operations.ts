/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Reading the operations out of an OpenAPI document, for binding a collection
 * that already exists (issue #638).
 *
 * It goes through the **import parsers** rather than walking `paths` again: they
 * already know 2.0 and 3.x, JSON and YAML, `$ref` path items and the methods
 * Vayu has no verb for, and they already produce the exact `specOperation`
 * identity an import stamps. A second reader here would be a hand-rolled copy of
 * the thing whose fixes it would stop receiving - and, worse, one that could
 * disagree with import about what a document contains.
 *
 * The drafts it builds are thrown away; only the identities are kept. Binding an
 * existing collection deliberately creates no requests (that is sync, #627).
 */

import type { SpecOperation } from "@/types";
import { parseImport } from "@/services/importers/factory";
import type { CollectionDraft, RequestDraft } from "@/services/importers/types";

/**
 * One operation, and the request an import of this document would build for it
 * (issue #654).
 *
 * The draft is what makes "the spec changed this request" answerable without a
 * second opinion about what a document means: sync compares what the collection
 * holds against what an import *would* produce, so the two can only disagree if
 * the document did.
 */
export interface SpecRequestDraft {
	operation: SpecOperation;
	draft: RequestDraft;
	/**
	 * The sub-collection an import files this operation under - its first tag,
	 * else the folder its path names (issue #710) - and `""` for an operation
	 * that gets neither, which imports onto the root (issue #655).
	 *
	 * Kept because applying an *added* operation has to put the request
	 * somewhere, and "where an import would have put it" is the only answer that
	 * leaves a synced collection shaped like an imported one. A name rather than
	 * a draft reference: the tag collection an added operation needs may already
	 * exist under the bound collection, and matching it by the name the parser
	 * gave it is what tells those two cases apart.
	 */
	folder: string;
}

/** What a document turned out to describe. */
export interface ReadSpecResult {
	/**
	 * Every operation the document declares, in document order, paired with the
	 * request an import would build for it.
	 */
	requests: SpecRequestDraft[];
	/** Every operation the document declares, in document order. */
	operations: SpecOperation[];
	/** The parser that claimed it - "OpenAPI 3.0", "OpenAPI 2.0 (Swagger)". */
	format: string;
	/** `info.title`, which is what the document calls itself. */
	title: string;
}

/**
 * A document Vayu could read, but which is not a specification.
 *
 * Its own error because the two failures need different words: a Postman export
 * is a perfectly good file that simply cannot be a contract, and telling the
 * user "unrecognised format" about a file the app imports happily would be a
 * lie.
 */
export class NotASpecError extends Error {
	constructor(format: string) {
		super(`This is ${format}, not an OpenAPI document.`);
		this.name = "NotASpecError";
	}
}

export function readSpecOperations(raw: string): ReadSpecResult {
	const result = parseImport(raw, { importEnvironments: false, importScripts: false });
	const root = result.collections[0];
	// `spec` is set by the OpenAPI parsers and by nothing else, so its presence
	// *is* the "this document is a contract" test - no format-name matching, which
	// would need updating every time a parser is added or renamed.
	if (!root?.spec) throw new NotASpecError(result.meta.format);

	const requests: SpecRequestDraft[] = [];
	collect(root, requests, "");
	return {
		requests,
		// Derived rather than collected a second time: one walk, so a reader that
		// wants identities and a reader that wants drafts cannot disagree about
		// what the document declares.
		operations: requests.map((r) => r.operation),
		format: result.meta.format,
		title: root.name,
	};
}

/**
 * @param folder the name of the sub-collection being walked, `""` for the root.
 * The OpenAPI parsers nest exactly one level - a tag collection per tag, on the
 * root - so this is the whole of an operation's position, not a truncation of a
 * deeper path.
 */
function collect(collection: CollectionDraft, out: SpecRequestDraft[], folder: string): void {
	for (const request of collection.requests) {
		if (request.specOperation) {
			out.push({ operation: request.specOperation, draft: request, folder });
		}
	}
	for (const child of collection.children) collect(child, out, child.name);
}
