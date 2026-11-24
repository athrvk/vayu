/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The raw HTTP exchange in `curl -v` notation: `>` for what was sent, `<` for what came back. In
 * Postman and Bruno "Raw" is the unformatted body and the exchange lives elsewhere (Bruno's
 * Timeline, Postman's Console); none joins both halves into one blob.
 *
 * - **The tab stays "Raw", deliberately**, despite the body toolbar's Raw segment meaning the
 *   unformatted body: "Timeline" implies calls over time beside a tab called Timing, and "Wire
 *   time" already names libcurl's transfer phase in the Timing summary. The prefixes make the
 *   content self-evidently an exchange.
 * - **Prefixes, not a separator line**: every line says its half, a pasted excerpt stays
 *   unambiguous, and there is no marker string for this component and the grammar to disagree on.
 * - **No response half when nothing came back.** A `status: 0` exchange (timeout, refused
 *   connection, failed handshake) has none, and `buildRawResponse` would print `HTTP/1.1 0`, a
 *   status no server sent; it shows the sent request alone, or an empty state when none was
 *   recorded (a failure before sending, such as an invalid URL). Any other response renders both
 *   halves, with or without a request: restored traces omit `rawRequest`.
 * - **The body is as received** (`bodyRaw`, #2459), not Pretty's indented copy: indentation the
 *   server never sent is not part of the exchange.
 * - **Headers are the lines as received** (#2460): `Set-Cookie` twice is two lines, names keep the
 *   server's case. A response restored from before lines were stored prints the folded map.
 * - **A body with no text view is one line saying so** (#2458): its bytes are `rawBytes`, and
 *   neither base64 nor a lossy decode is what the server sent.
 * - **The body is capped at `LARGE_BODY_BYTES`, the Body tab's limit** (#3138): past it only that
 *   many characters are built and handed to the editor, under the same "Large response" notice, as
 *   `buildRawResponse`, `markLines` and a Monaco model over the whole body are the passes that
 *   limit avoids. The test is the received string's length alone (Raw prints that string), memoised
 *   on the fields read, so an unchanged re-render does not rebuild a 2MB string.
 * - **`language="http"` is real**: Monaco ships none; see `lib/http-language.ts`.
 */

import { useMemo } from "react";
import { CodeEditor } from "@/components/ui";
import { EmptyState } from "@/components/shared";
import {
	buildRawResponse,
	LARGE_BODY_BYTES,
	LargeBodyNotice,
} from "@/components/shared/response-viewer";
import { receivedBody, type ResponseBytes } from "../../utils/response-bytes";
import type { HeaderLine } from "@/types/domain";
import { formatBytes } from "@/lib/format-number";
import { markLines, SENT_MARKER, RECEIVED_MARKER } from "@/lib/http-language";

export interface RawRequestResponseProps {
	rawRequest: string;
	response: {
		status: number;
		statusText: string;
		headers: Record<string, string>;
		/**
		 * `ResponseState.headerLines`, printed as received, one line each; the folded `headers` is
		 * the fallback without them.
		 */
		headerLines?: HeaderLine[];
		body: string;
		/** `ResponseState.bodyRaw`: the body as received, which the received half prints. */
		bodyRaw?: string;
		/**
		 * The negotiated protocol (`ResponseState.httpVersion`); `buildRawResponse` documents the
		 * display contract and fallback.
		 */
		httpVersion?: string;
		/** `ResponseState.rawBytes`: set for a body the engine sent as base64. */
		rawBytes?: ResponseBytes;
	};
}

export default function RawRequestResponse({ rawRequest, response }: RawRequestResponseProps) {
	if (response.status === 0) {
		return rawRequest ? (
			<RawEditor value={markLines(rawRequest, SENT_MARKER)} />
		) : (
			<EmptyState variant="inline" title="No request was recorded" />
		);
	}

	return <ReceivedExchange rawRequest={rawRequest} response={response} />;
}

/** Split out so the memo below sits after the `status: 0` return without breaking hook order. */
function ReceivedExchange({ rawRequest, response }: RawRequestResponseProps) {
	const { status, statusText, headers, headerLines, body, bodyRaw, httpVersion, rawBytes } =
		response;

	// The fields read, not `response`: the parent hands a new object on any response change, and a
	// 2MB rebuild is not free.
	const { value, bodyLength } = useMemo(
		() =>
			buildExchange(rawRequest, {
				status,
				statusText,
				headers,
				headerLines,
				body,
				bodyRaw,
				httpVersion,
				rawBytes,
			}),
		[rawRequest, status, statusText, headers, headerLines, body, bodyRaw, httpVersion, rawBytes]
	);

	return (
		<div className="flex h-full flex-col">
			{bodyLength !== null && (
				<LargeBodyNotice
					bodyLength={bodyLength}
					downloadNote="Download from the Body tab saves the body the app received."
				/>
			)}
			<div className="flex-1 min-h-0">
				<RawEditor value={value} />
			</div>
		</div>
	);
}

/**
 * The exchange as one string, plus the received body's full length when cut to `LARGE_BODY_BYTES`
 * (else `null`).
 */
function buildExchange(
	rawRequest: string,
	response: RawRequestResponseProps["response"]
): { value: string; bodyLength: number | null } {
	const { text, bodyLength } = bodyToPrint(response);
	const rawResponse = buildRawResponse(
		response.status,
		response.statusText,
		response.headerLines ?? response.headers,
		text,
		response.httpVersion
	);
	const received = markLines(rawResponse, RECEIVED_MARKER);

	/*
	 * No blank line between the halves: `markLines` ends the request with a bare `>` (the blank
	 * line closing a head) and the response opens on `< HTTP/1.1 ...`, exactly `curl -v`'s output
	 * and what the grammar reads as the response head starting.
	 */
	return {
		value: rawRequest ? `${markLines(rawRequest, SENT_MARKER)}\n${received}` : received,
		bodyLength,
	};
}

/**
 * What the received half prints for the body; a body with no text view is one line, so only a
 * printed body is cut.
 */
function bodyToPrint(response: RawRequestResponseProps["response"]): {
	text: string;
	bodyLength: number | null;
} {
	const { rawBytes } = response;
	if (rawBytes && !rawBytes.isText) {
		return {
			text: `[${formatBytes(rawBytes.data.length)} of binary data, not shown as text. Download it from the Body tab.]`,
			bodyLength: null,
		};
	}
	const full = receivedBody(response);
	if (full.length <= LARGE_BODY_BYTES) return { text: full, bodyLength: null };
	return { text: full.slice(0, LARGE_BODY_BYTES), bodyLength: full.length };
}

function RawEditor({ value }: { value: string }) {
	return (
		<CodeEditor
			height="100%"
			language="http"
			ariaLabel="Raw request and response"
			value={value}
			readOnly
			/*
			 * No line numbers and no gutter: every line opens with `>` or `<`, so numbers would be
			 * a second left rail competing with the one that means something, and nothing here
			 * refers to a line by number (unlike Body, where paths and line numbers name payload
			 * parts). `lineNumbersMinChars: 0` and `lineDecorationsWidth: 0` matter as much as
			 * `lineNumbers: "off"`: without them Monaco still reserves the gutter.
			 */
			options={{
				folding: false,
				lineNumbers: "off",
				lineNumbersMinChars: 0,
				lineDecorationsWidth: 0,
				glyphMargin: false,
			}}
		/>
	);
}
