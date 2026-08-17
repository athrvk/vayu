/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The stored request as a snippet input - the Code section's Templated mode.
 *
 * Its counterpart is `POST /compose`, which the engine owns; this is the only
 * half the renderer builds itself, and it builds it by *not* resolving.
 */

import { resolveAuthForSend } from "@/modules/request-builder/utils/auth-resolution";
import type { SnippetRequest } from "@/services/codegen";
import type { KeyValueEntry, Request } from "@/types";

/** Enabled rows only, last one wins - the same rule the execute path applies. */
function flatHeaders(entries: KeyValueEntry[] | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const entry of entries ?? []) {
		if (entry.enabled !== false && entry.key.trim()) result[entry.key] = entry.value;
	}
	return result;
}

/**
 * Nothing is substituted - `{{host}}` stays `{{host}}`, which is the point of
 * the mode.
 *
 * `inherit` is still walked, because inheritance is structure rather than
 * interpolation: a templated snippet that dropped the inherited credential
 * would not be the request as written, it would be a different request.
 */
export function templatedRequest(
	request: Request,
	ancestors: Parameters<typeof resolveAuthForSend>[1]
): SnippetRequest {
	return {
		method: request.method,
		url: request.url,
		headers: flatHeaders(request.headers),
		body: request.body,
		auth: resolveAuthForSend(request.auth, ancestors),
		// An execution setting, so it comes off the row in both modes - see
		// `CodeSection` for why the resolved mode cannot read it from the
		// composed payload.
		stream: request.stream,
		verifySSL: request.verifySSL,
	};
}
