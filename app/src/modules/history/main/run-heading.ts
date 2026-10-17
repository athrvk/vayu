/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a run's header says it is, from a loaded run (`GET /runs/:id`, #2270).
 *
 * Read through `runReferenceInput` for the reason it exists: a loaded run has
 * the full `configSnapshot` and no `summary`, a list row the reverse, and a
 * surface that read one shape would name every run of the other by its type.
 */

import type { Collection, Run } from "@/types";
import { DEFAULT_REQUEST_NAME } from "@/constants/request";
import { runReferenceInput } from "@/lib/run-reference-input";
import { RUN_TYPE_NAME } from "../types";

/**
 * The request's name, else the collection a sequence ran, else the run's type.
 *
 * A request still named the default says nothing a type does not, so it yields
 * (the history row's rule). The collection's id stands in once the collection is
 * deleted, never a blank. A scenario *load* run is `type: "load"` but has no
 * request, so the collection is read wherever the run names one, not by `type`.
 */
export function runTitle(run: Run, collections: readonly Pick<Collection, "id" | "name">[]) {
	const summary = runReferenceInput(run).summary;
	const requestName = summary?.requestName?.trim();
	if (requestName && requestName !== DEFAULT_REQUEST_NAME) return requestName;

	const collectionId = summary?.scenario?.collectionId;
	if (collectionId) return collections.find((c) => c.id === collectionId)?.name ?? collectionId;

	return RUN_TYPE_NAME[run.type];
}

/**
 * The comment the run was started with, or `undefined`.
 *
 * The snapshot first, because it is the only one a loaded run has; the summary
 * is for a list row passed in from the sidebar. Whitespace alone is no comment.
 */
export function runComment(run: Run): string | undefined {
	return (run.configSnapshot?.comment ?? run.summary?.comment)?.trim() || undefined;
}
