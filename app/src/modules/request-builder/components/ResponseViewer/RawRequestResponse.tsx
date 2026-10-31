/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The raw HTTP exchange, in `curl -v` notation - `>` for what was sent, `<` for
 * what came back.
 *
 * **Nothing else does it the way this used to.** In Postman and Bruno, "Raw" in
 * a response pane means the *unformatted response body* - one of Pretty / Raw /
 * Preview - and the whole exchange lives somewhere else entirely: Bruno calls it
 * the Timeline, Postman puts it in the Console. JMeter splits it across Sampler
 * result / Request / Response data. None of them concatenates the two halves
 * into one blob with a divider through the middle, which is what this did.
 *
 * **The tab stays called "Raw", deliberately.** That does collide with the body
 * toolbar's Raw segment, which means the other thing - the unformatted body -
 * and the collision was weighed rather than missed. The alternatives were worse:
 * "Timeline" implies a sequence of calls over time and would sit beside a tab
 * already called Timing, and "Wire" is taken inside Vayu, where the Timing
 * summary uses it for the libcurl transfer phase. Renaming to dodge one
 * collision by creating another is not a trade. The prefixes below also carry
 * most of the weight the name would have: the content is self-evidently an
 * exchange the moment you look at it.
 *
 * The prefixes are the closest thing to a convention a reader already knows,
 * and they beat a separator line in three ways: every line says which half it
 * belongs to instead of only the boundary saying it, an excerpt pasted into an
 * issue stays unambiguous even without the boundary, and there is no marker
 * string for this component and the grammar to disagree about - which they had
 * already managed to do once.
 *
 * **There is no response half when nothing came back.** A `status: 0` exchange
 * (a timeout, a refused connection, a failed handshake) has no response, and
 * `buildRawResponse` would still print `HTTP/1.1 0` under the real request - a
 * status line no server sent. That case shows the sent request alone, and an
 * empty state when the engine recorded none (a failure before the send, such as
 * an invalid URL). Every other response still renders both halves with or
 * without a recorded request: restored traces omit `rawRequest`.
 *
 * **The body is printed as received** (`bodyRaw`, issue #2459), not the indented
 * copy the Pretty view reads: this tab is the exchange, and indentation the
 * server never sent does not belong in it.
 *
 * **The headers are the lines as received** (issue #2460): `Set-Cookie` twice
 * is two lines, and a name keeps the case the server wrote it in. A response
 * restored from before the lines were stored prints the folded map instead.
 *
 * **A body with no text view is one line saying so** (issue #2458): its
 * bytes are `rawBytes`, and neither their base64 nor a lossy decoding is what
 * the server sent.
 *
 * **The body is capped at `LARGE_BODY_BYTES`, the Body tab's limit** (issue
 * #3138). Past it only the first that many characters are built into the
 * exchange and handed to the editor, with the same "Large response" notice
 * above it: `buildRawResponse`, `markLines` and a Monaco model over the whole
 * body are the passes that limit exists to avoid, and this tab paid them for
 * any size. The test is the length of the received string alone - Raw prints
 * that one string - and the result is memoised on the fields it reads, so a
 * re-render with the same response does not rebuild a 2MB string.
 *
 * **`language="http"` finally means something.** Monaco ships no `http`
 * language, so this editor had been falling back to plain text since it was
 * written - see `lib/http-language.ts`.
 */

import { useMemo } from "react";
import { CodeEditor } from "@/components/ui";
import { EmptyState } from "@/components/shared";
import {
	buildRawResponse,
	formatSize,
	LARGE_BODY_BYTES,
	LargeBodyNotice,
} from "@/components/shared/response-viewer";
import { receivedBody, type ResponseBytes } from "../../utils/response-bytes";
import type { HeaderLine } from "@/types/domain";
import { markLines, SENT_MARKER, RECEIVED_MARKER } from "@/lib/http-language";

export interface RawRequestResponseProps {
	rawRequest: string;
	response: {
		status: number;
		statusText: string;
		headers: Record<string, string>;
		/**
		 * `ResponseState.headerLines`: printed as received, one line each. The
		 * folded `headers` is the fallback for a response that has none.
		 */
		headerLines?: HeaderLine[];
		body: string;
		/** `ResponseState.bodyRaw`: the body as received, which the received half prints. */
		bodyRaw?: string;
		/**
		 * The negotiated protocol - `ResponseState.httpVersion`. See
		 * `buildRawResponse`'s doc comment for the display-string contract and
		 * what an omitted or empty value falls back to.
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

	// The fields it reads, not `response`: the parent hands over a new object whenever
	// anything on the response changes, and a 2MB rebuild is not free.
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
 * The exchange as one string, and the received body's full length when it was
 * cut to `LARGE_BODY_BYTES` (`null` when nothing was).
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
	 * No blank line between the halves: `markLines` ends the request with a bare
	 * `>`, which is the blank line that closes a head, and the response opens on
	 * `< HTTP/1.1 ...`. That is exactly what `curl -v` prints, and it is what the
	 * grammar reads to know the response head has started.
	 */
	return {
		value: rawRequest ? `${markLines(rawRequest, SENT_MARKER)}\n${received}` : received,
		bodyLength,
	};
}

/**
 * What the received half prints for the body. A body with no text view is one
 * line, however big its bytes are, so only a printed body is ever cut.
 */
function bodyToPrint(response: RawRequestResponseProps["response"]): {
	text: string;
	bodyLength: number | null;
} {
	const { rawBytes } = response;
	if (rawBytes && !rawBytes.isText) {
		return {
			text: `[${formatSize(rawBytes.data.length)} of binary data, not shown as text. Download it from the Body tab.]`,
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
			 * No line numbers, and no gutter left where they were.
			 *
			 * Every line already opens with `>` or `<`, so a number column is a
			 * second left-hand rail competing with the one that carries meaning.
			 * Nothing here refers to a line by number either - unlike the Body
			 * tab, where a JSON path and a line number are how you talk about a
			 * payload.
			 *
			 * `lineNumbersMinChars: 0` and `lineDecorationsWidth: 0` matter as
			 * much as `lineNumbers: "off"`: without them Monaco keeps reserving
			 * the gutter, and the markers start a couple of characters in from
			 * the edge for no reason.
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
