/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatSize } from "@/components/shared/response-viewer/utils";
import { decodeResponseBody } from "@/modules/request-builder/utils/response-bytes";
import type { InboxCannedResponse, InboxCapture } from "@/types";

/**
 * The absolute URL a capture arrived at.
 *
 * The engine records the path and the raw query separately - that is what the
 * capture *is* - so the URL the viewer and the raw HTTP text need is rebuilt
 * here rather than stored twice.
 */
export function captureUrl(capture: InboxCapture, inboxUrl: string): string {
	const base = inboxUrl.endsWith("/") ? inboxUrl.slice(0, -1) : inboxUrl;
	return `${base}${capture.path}${capture.query ? `?${capture.query}` : ""}`;
}

/**
 * A React key that changes exactly when the served canned response does.
 *
 * `CannedResponseControls` holds every field as a draft, so it is re-seeded by
 * remount rather than by an effect - and that only works if the key covers all
 * four fields. It covered two, so a body or header set changed by an MCP tool
 * or a curl left the panel showing the values it was mounted with.
 */
export function cannedResponseKey(inboxId: string, response: InboxCannedResponse): string {
	const headers = Object.entries(response.headers)
		.map(([name, value]) => `${name}=${value}`)
		.join("|");
	return [inboxId, response.status, response.delayMs, response.body, headers].join("\u0000");
}

/**
 * The exact bytes a base64 capture stored, or `null` for a body that is text or
 * whose base64 does not decode. Never throws: the capture is read in render,
 * and a body the engine mislabelled must leave the rest of the pane readable.
 *
 * No headers are passed on purpose. `decodeResponseBody` would otherwise read a
 * `text/*` type as a body to decode through a charset, and a capture whose bytes
 * the engine already found are not UTF-8 is shown as bytes whatever it claims.
 */
export function captureBinaryBytes(
	capture: Pick<InboxCapture, "body" | "bodyEncoding">
): Uint8Array<ArrayBuffer> | null {
	if (capture.bodyEncoding !== "base64") return null;
	try {
		return (
			decodeResponseBody({ bodyRaw: capture.body, bodyEncoding: "base64" }).bytes?.data ??
			null
		);
	} catch {
		return null;
	}
}

/**
 * The line that stands where a base64 body would print in the Raw view. The
 * size is `bodyBytes`, what arrived, and `held` is how much of it the engine
 * kept: they differ exactly when the body was truncated.
 */
export function binaryBodyPlaceholder(
	capture: Pick<InboxCapture, "bodyBytes" | "bodyTruncated">,
	held: number | undefined
): string {
	const received = formatSize(capture.bodyBytes);
	if (capture.bodyTruncated && held !== undefined) {
		return `[Binary data, not shown as text: the first ${formatSize(held)} of ${received} was kept.]`;
	}
	return `[${received} of binary data, not shown as text.]`;
}
