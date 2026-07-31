/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Does this request carry a dynamic variable anywhere the send path resolves?
 *
 * Read by the load-test dialog, which warns that a run interpolates once and
 * therefore repeats the generated value across every iteration. It scans exactly
 * the fields `handleConfirmLoadTest` passes through `resolveString` - URL,
 * headers, body, form-data and url-encoded fields - so the warning appears when,
 * and only when, a value will actually be generated. Auth is not scanned: it is
 * resolved from the collection chain rather than typed here, and a credential
 * built out of a generator is not a case this warning is for.
 */

import { containsDynamicVariable } from "@/lib/dynamic-variables";
import type { KeyValueItem, RequestState } from "../types";

function anyRow(rows: KeyValueItem[] | undefined): boolean {
	return (rows ?? []).some(
		(row) =>
			row.enabled !== false &&
			(containsDynamicVariable(row.key) || containsDynamicVariable(row.value))
	);
}

export function requestUsesDynamicVariables(
	request: Pick<RequestState, "url" | "headers" | "body" | "formData" | "urlEncoded"> | null
): boolean {
	if (!request) return false;
	return (
		containsDynamicVariable(request.url) ||
		containsDynamicVariable(request.body) ||
		anyRow(request.headers) ||
		anyRow(request.formData) ||
		anyRow(request.urlEncoded)
	);
}
