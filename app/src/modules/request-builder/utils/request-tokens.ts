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
 * Whether the request holds a `{{token}}` in any field a token painter draws.
 *
 * The gate for asking the engine which names a pre-request script defers
 * (#2741): a request with none has nothing to paint, so a literal one costs no
 * compose. It reads every mode's fields, not only the active body mode's - the
 * answer is a cost gate, and a token in a hidden mode costs one compose the
 * Code section would pay anyway. The auth is scanned whole, OAuth 2.0 config
 * included, because the engine defers that config's names too.
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
