/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What an import of an OpenAPI document builds - **for the conformance suites
 * only** (issue #869).
 *
 * `services/openapi/spec-operations.ts` did this for the Spec tab until the tab
 * stopped reading documents (`POST /specs/describe`), and it is gone: nothing
 * the app ships parses a spec to answer what it declares any more. What is left
 * is the question the two cross-language fixtures ask - *does an import of this
 * document stamp the identities, and build the requests, that the engine derives
 * from the same bytes?* - and that question outlives the reader, because the
 * import pipeline still parses documents and still stamps `specOperation` on
 * every request it creates. A stamp the engine's index cannot resolve credits
 * the wrong operation rather than failing.
 *
 * So this walks the collection tree the parsers built, exactly as the deleted
 * module did, and lives beside the suites that read it rather than among the
 * services - a `.testkit.ts` file is not part of the app, and no production
 * import of it should ever appear.
 */

import { parseImport } from "@/services/importers/factory";
import type { CollectionDraft, RequestDraft } from "@/services/importers/types";
import type { SpecOperation } from "@/types";

/** One operation, and the request an import of this document would build for it. */
export interface ImportedOperation {
	operation: SpecOperation;
	draft: RequestDraft;
	/**
	 * The sub-collection an import files this operation under - its first tag,
	 * else the folder its path names (issue #710) - and `""` for an operation
	 * that gets neither, which imports onto the root (issue #655).
	 */
	folder: string;
}

/**
 * Every operation the parsers found in @p raw, paired with the request they
 * built for it, in the order the collection tree lists them (root requests
 * first, then each tag folder).
 *
 * That order is deliberately *not* document order - the engine's is - so a
 * comparison against the fixture keys by identity rather than by position. Both
 * suites do.
 */
export function importedOperations(raw: string): ImportedOperation[] {
	const result = parseImport(raw, { importEnvironments: false, importScripts: false });
	const root = result.collections[0];
	// `spec` is set by the OpenAPI parsers and by nothing else, so its presence
	// *is* the "this document is a contract" test.
	if (!root?.spec) {
		throw new Error(`This is ${result.meta.format}, not an OpenAPI document.`);
	}
	const out: ImportedOperation[] = [];
	collect(root, out, "");
	return out;
}

/**
 * @param folder the name of the sub-collection being walked, `""` for the root.
 * The OpenAPI parsers nest exactly one level - a tag collection per tag, on the
 * root - so this is the whole of an operation's position.
 */
function collect(collection: CollectionDraft, out: ImportedOperation[], folder: string): void {
	for (const request of collection.requests) {
		if (request.specOperation) {
			out.push({ operation: request.specOperation, draft: request, folder });
		}
	}
	for (const child of collection.children) collect(child, out, child.name);
}
