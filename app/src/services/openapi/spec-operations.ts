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
import type { CollectionDraft } from "@/services/importers/types";

/** What a document turned out to describe. */
export interface ReadSpecResult {
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

	const operations: SpecOperation[] = [];
	collect(root, operations);
	return {
		operations,
		format: result.meta.format,
		title: root.name,
	};
}

function collect(collection: CollectionDraft, out: SpecOperation[]): void {
	for (const request of collection.requests) {
		if (request.specOperation) out.push(request.specOperation);
	}
	for (const child of collection.children) collect(child, out);
}
