/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A parsed curl/wget command as the preset `useNewRequest` creates a request
 * from (#2250): the stored column shapes the builder's save sends, so a request
 * created from a paste reads back the same as one saved from the URL bar.
 */

import type { RequestPreset } from "@/hooks/useNewRequest";
import type { ParsedRequest } from "@/services/curl/parseCurl";
import { toKeyValueEntries } from "@/components/shared/KeyValueEditor/key-value";
import { toBodyPayload } from "@/modules/request-builder/utils/execute-mapping";

export function presetFromCommand(request: ParsedRequest): RequestPreset {
	const body = toBodyPayload(request);
	return {
		method: request.method,
		url: request.url,
		params: toKeyValueEntries(request.params),
		headers: toKeyValueEntries(request.headers),
		body,
		bodyType: body.mode,
		auth: request.auth,
		stream: request.stream,
		verifySSL: request.verifySSL,
		followRedirects: request.followRedirects,
		maxRedirects: request.maxRedirects,
	};
}
