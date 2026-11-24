/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Why a response was not schema-checked, in words (#628). The engine sends codes and this side owns
 * the wording, one sentence per code in one place, not engine-built sentences every client must
 * match. Beside the component, as `save-as-example.ts` is beside its dialog: the rule outlives the
 * rendering, and a component file exporting constants loses fast refresh.
 */

import type { ValidationUncheckedReason } from "@/types";

export const UNCHECKED_REASONS: Record<ValidationUncheckedReason, string> = {
	no_operation: "This request is not bound to an operation in the spec.",
	no_index: "The bound document carries no response schemas. Re-bind or sync the collection.",
	hash_mismatch:
		"The stored document has changed since this collection was bound to it. Sync the collection.",
	never_stamped:
		"This collection's binding never recorded which version of the document it was bound to. Re-bind the collection.",
	operation_not_declared: "The spec no longer declares this operation.",
	no_schema_for_status: "The spec declares no schema for this status.",
	no_schema_for_content_type: "The spec declares no schema for this response's content type.",
	no_response: "There was no response to check.",
	body_not_json:
		"The response body is not JSON or nests too deeply to read, and a JSON Schema can't describe it.",
};

/**
 * An unknown code (an engine newer than the app) falls back to the honest generic, not a raw
 * identifier.
 */
export function uncheckedReasonText(reason: ValidationUncheckedReason | undefined): string {
	return (reason && UNCHECKED_REASONS[reason]) || "This response was not checked.";
}
