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
 * **The empty state is gone, because it could never render.** The guard was
 * `if (!rawRequest && !response)`, and `response` is a required object prop -
 * always truthy, so the condition was always false and "No raw data available"
 * had never been on screen. Rewriting the condition was the first attempt and
 * was also wrong: `buildRawResponse` always emits a status line, and the tab is
 * mounted behind `hasRaw = !!response.rawRequest`. Nothing here can be empty;
 * the check is the tab's *existence*, one level up.
 *
 * **`language="http"` finally means something.** Monaco ships no `http`
 * language, so this editor had been falling back to plain text since it was
 * written - see `lib/http-language.ts`.
 */

import { CodeEditor } from "@/components/ui";
import { buildRawResponse } from "@/components/shared/response-viewer";
import { markLines, SENT_MARKER, RECEIVED_MARKER } from "@/lib/http-language";

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

	const received = markLines(rawResponse, RECEIVED_MARKER);

	/*
	 * A ternary, not a guard clause. `rawRequest` is typed `string` and the
	 * caller gates on it being non-empty, so the else-branch is unreachable
	 * through the app - it is kept because it makes this total over its declared
	 * prop type, which returning an empty state did not.
	 *
	 * No blank line between the halves: `markLines` ends the request with a bare
	 * `>`, which is the blank line that closes a head, and the response opens on
	 * `< HTTP/1.1 ...`. That is exactly what `curl -v` prints, and it is what the
	 * grammar reads to know the response head has started.
	 */
	return (
		<CodeEditor
			height="100%"
			language="http"
			value={rawRequest ? `${markLines(rawRequest, SENT_MARKER)}\n${received}` : received}
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
