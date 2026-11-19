/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A Console row's exchange (#3634): request and response headers and bodies in
 * the shared `UnifiedResponseViewer`, as History's step card draws a stored
 * one. Every value is the row's, masked before it reached the ring.
 *
 * A body the ring cut at `CONSOLE_BODY_MAX_CHARS` says so above the viewer; a
 * row with a run points at History, whose stored trace keeps more.
 */

import { useMemo } from "react";
import { UnifiedResponseViewer } from "@/components/shared/response-viewer";
import { CONSOLE_BODY_MAX_CHARS, type ConsoleExchange } from "@/stores/console-store";
import { formatBytes } from "@/lib/format-number";
import { decodeResponseBody } from "@/modules/request-builder/utils/response-bytes";

/** The response body as the viewer takes it: text, or the bytes of a base64 one. */
function viewedResponse(exchange: ConsoleExchange) {
	const body = exchange.responseBody;
	const headers = exchange.responseHeaders;
	if (!body) return { body: "", headers };
	const decoded = decodeResponseBody({
		bodyRaw: body.text,
		bodyEncoding: body.base64 ? "base64" : undefined,
		headers,
	});
	return {
		body: decoded.text,
		bodyRaw: decoded.text,
		...(decoded.bytes && { rawBytes: decoded.bytes }),
		headers,
	};
}

function CutNotice({ exchange }: { exchange: ConsoleExchange }) {
	const which = [
		exchange.requestBody?.cut && "request",
		exchange.responseBody?.cut && "response",
	].filter(Boolean);
	if (which.length === 0) return null;
	return (
		<p className="text-xs text-muted-foreground">
			The console kept the first {formatBytes(CONSOLE_BODY_MAX_CHARS)} of the{" "}
			{which.join(" and ")} {which.length > 1 ? "bodies" : "body"}.
		</p>
	);
}

export function ExchangeView({ exchange }: { exchange: ConsoleExchange }) {
	// Memoized: a base64 body decodes to fresh bytes on every call, and an image
	// preview keyed on them would make a new object URL per render.
	const response = useMemo(() => viewedResponse(exchange), [exchange]);
	return (
		<div className="space-y-2">
			<CutNotice exchange={exchange} />
			<UnifiedResponseViewer
				response={response}
				request={{
					headers: exchange.requestHeaders,
					body: exchange.requestBody?.text,
				}}
				className="max-h-[400px]"
			/>
		</div>
	);
}
