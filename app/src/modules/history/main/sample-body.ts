/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the response viewer is handed for a captured load-run sample (#3159).
 *
 * `GET /runs/:id/samples` spells a body that is not valid UTF-8 text, or holds
 * a zero byte, as base64 (`bodyEncoding`). It goes through the decoder the
 * design-mode funnels use, so a text type reads as text through its charset
 * and any other type becomes `rawBytes`, which the viewer renders as a
 * binary body instead of a wall of base64.
 */

import {
	decodeResponseBody,
	type ResponseBytes,
} from "@/modules/request-builder/utils/response-bytes";
import type { RunSample } from "@/types/domain";

export interface CapturedBody {
	body: string;
	rawBytes?: ResponseBytes;
	/** Why the body is not shown: the engine marked it base64 and it does not decode. */
	unreadable?: string;
}

/**
 * Never throws: it is read in render, and a body the engine mislabelled must
 * leave the sample's headers and timings readable.
 */
export function capturedBody(response: RunSample["response"]): CapturedBody {
	try {
		const decoded = decodeResponseBody({
			bodyRaw: response.body ?? "",
			bodyEncoding: response.bodyEncoding,
			headers: response.headers,
		});
		return { body: decoded.text, rawBytes: decoded.bytes };
	} catch (error) {
		return { body: "", unreadable: error instanceof Error ? error.message : String(error) };
	}
}
