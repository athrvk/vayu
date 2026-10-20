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
import { toHeaderRows } from "@/modules/request-builder/utils/key-value";
import type { SnippetRequest } from "@/services/codegen";
import type { Request } from "@/types";

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
		// Its path rows fill the URL's `:name` segments (#1764), as compose does.
		params: request.params,
		// Enabled rows in order, repeats kept: the lines the execute path sends.
		headers: toHeaderRows(request.headers ?? []),
		body: request.body,
		auth: resolveAuthForSend(request.auth, ancestors),
		// An execution setting, so it comes off the row in both modes - see
		// `CodeSection` for why the resolved mode cannot read it from the
		// composed payload.
		stream: request.stream,
		verifySSL: request.verifySSL,
		followRedirects: request.followRedirects,
		disableUrlEncoding: request.disableUrlEncoding,
	};
}
