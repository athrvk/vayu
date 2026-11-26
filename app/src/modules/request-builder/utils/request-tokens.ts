/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { containsVariableToken } from "@/constants/variables";
import type { KeyValueItem } from "@/types";
import type { RequestState } from "../types";

type TokenBearingRequest = Pick<
	RequestState,
	"url" | "params" | "headers" | "body" | "formData" | "urlEncoded" | "binaryFile" | "auth"
>;

/** Every string a row can carry a `{{token}}` in, a form file part's included. */
function rowStrings(rows: readonly KeyValueItem[]): Array<string | undefined> {
	return rows.flatMap((row) => [row.key, row.value, row.src, row.fileName, row.contentType]);
}

/**
 * Whether any field a token painter draws holds a `{{token}}`: the gate for asking the engine which
 * names a pre-request script defers (#2741), so a literal request costs no compose. Every mode's
 * fields are read, not only the active one: it is a cost gate, and a hidden mode's token costs one
 * compose the Code section pays anyway. Auth is scanned whole, OAuth 2.0 config included, as the
 * engine defers its names too.
 */
export function requestHasTokens(request: TokenBearingRequest): boolean {
	const { binaryFile } = request;
	return [
		request.url,
		request.body,
		...rowStrings(request.params),
		...rowStrings(request.headers),
		...rowStrings(request.formData),
		...rowStrings(request.urlEncoded),
		binaryFile.src,
		binaryFile.fileName,
		binaryFile.contentType,
		JSON.stringify(request.auth),
	].some(containsVariableToken);
}
