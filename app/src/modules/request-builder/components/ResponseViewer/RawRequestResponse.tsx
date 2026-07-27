/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The raw HTTP exchange - request above, response below.
 *
 * **The empty state is gone, because it could never render.** The guard was
 * `if (!rawRequest && !response)`, and `response` is a required object prop -
 * always truthy, so the condition was always false and "No raw data available"
 * had never been on screen.
 *
 * Rewriting the condition was the first attempt and was also wrong: nothing
 * here can be empty. `buildRawResponse` always emits a status line, so the
 * response half is never blank; and the tab is mounted behind
 * `hasRaw = !!response.rawRequest` in `ResponseViewer`, so the request half is
 * never blank either. The emptiness check is the tab's *existence*, one level
 * up. A second dead guard in place of the first would have been the same defect
 * wearing a better condition.
 *
 * **The separator is no longer 60 hardcoded box characters.** `"─".repeat(60)`
 * is a fixed width in a pane the user resizes: too narrow and it reads as a
 * stray line, too wide and it wraps into two. It is also *content* - it lands in
 * the clipboard when someone copies the exchange into a bug report, where it is
 * not part of any HTTP message. A commented line survives that unambiguously,
 * and the `http` grammar tokenizes it as a comment.
 *
 * **`language="http"` finally means something.** Monaco ships no `http`
 * language, so this editor had been falling back to plain text since it was
 * written - see `lib/http-language.ts`.
 */

import { CodeEditor } from "@/components/ui";
import { buildRawResponse } from "@/components/shared/response-viewer";
// One definition, beside the grammar that has to match it.
import { RAW_SEPARATOR } from "@/lib/http-language";

export interface RawRequestResponseProps {
	rawRequest: string;
	response: {
		status: number;
		statusText: string;
		headers: Record<string, string>;
		body: string;
	};
}

export default function RawRequestResponse({ rawRequest, response }: RawRequestResponseProps) {
	const rawResponse = buildRawResponse(
		response.status,
		response.statusText,
		response.headers,
		response.body
	);

	/*
	 * The ternary, not a guard clause. `rawRequest` is typed `string` and the
	 * caller gates on it being non-empty, so the else-branch is unreachable
	 * through the app - it is kept because it makes this a total function over
	 * its declared prop type, which a guard clause returning an empty state did
	 * not.
	 */
	/*
	 * A blank line *before* the separator and none after. That is a grammar
	 * constraint, not a typographic preference: a blank line is what ends a head
	 * and begins a body in HTTP, and the tokenizer uses it as exactly that. A
	 * blank after the separator sent it straight back into body-reading before
	 * the status line arrived, which left the entire response half - status
	 * line, headers and all - unhighlighted. The blank before is free, because
	 * it lands while already inside the request's body, where it means nothing.
	 */
	const combinedRaw = rawRequest
		? `${rawRequest}\n\n${RAW_SEPARATOR}\n${rawResponse}`
		: rawResponse;

	return (
		<CodeEditor
			height="100%"
			language="http"
			value={combinedRaw}
			readOnly
			options={{ folding: false }}
		/>
	);
}
