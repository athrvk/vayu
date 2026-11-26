/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { resolveHeaderLines } from "@/lib/header-lines";
import type { ResponseState } from "../../types";

/**
 * The `WWW-Authenticate` values to ask `POST /oauth2/step-up` about, or `[]` when @p response
 * cannot be a step-up: only a 403 can (RFC 6750 section 3.1). Each received line is its own value,
 * so a challenge split across lines is read as sent.
 */
export function stepUpChallenges(
	response: Pick<ResponseState, "status" | "headers" | "headerLines">
): string[] {
	if (response.status !== 403) return [];
	return resolveHeaderLines(response.headers, response.headerLines)
		.filter((line) => line.name.toLowerCase() === "www-authenticate")
		.map((line) => line.value);
}
