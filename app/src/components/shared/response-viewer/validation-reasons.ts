/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Why a response was not checked against its schema, in words (issue #628).
 *
 * The engine sends codes and this side owns the wording - one sentence per
 * code, in one place, rather than a sentence built engine-side that every
 * client would then have to match. Beside the component rather than inside it
 * for the reason `save-as-example.ts` sits beside its dialog: the rule outlives
 * the rendering, and a component file that also exports constants costs the
 * whole module its fast refresh.
 */

import type { ValidationUncheckedReason } from "@/types";

export const UNCHECKED_REASONS: Record<ValidationUncheckedReason, string> = {
	no_operation: "This request is not bound to an operation in the spec.",
	no_index: "The bound document carries no response schemas. Re-bind or sync the collection.",
	hash_mismatch:
		"The stored document has changed since this collection was bound to it. Sync the collection.",
	operation_not_declared: "The spec no longer declares this operation.",
	no_schema_for_status: "The spec declares no response for this status.",
	no_schema_for_content_type: "The spec declares no schema for this response's content type.",
	no_response: "There was no response to check.",
	body_not_json: "The response body is not JSON, and a JSON Schema cannot describe it.",
};

/**
 * An unknown code - an engine newer than this app - falls back to the honest
 * generic rather than rendering a raw identifier at a user.
 */
export function uncheckedReasonText(reason: ValidationUncheckedReason | undefined): string {
	return (reason && UNCHECKED_REASONS[reason]) || "This response was not checked.";
}
