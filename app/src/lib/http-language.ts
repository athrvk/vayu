/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A Monaco language for a raw HTTP exchange.
 *
 * The Raw tab has always passed `language="http"` to its editor, and there has
 * never been an `http` language to receive it. Monaco ships ~90 basic languages
 * and that is not one of them - checked against
 * `monaco-editor/esm/vs/basic-languages/`, which has `html`, `hcl` and
 * `handlebars` but nothing HTTP. Monaco silently falls back to plain text for an
 * unknown id, so the one tab whose entire job is reading a protocol exchange has
 * been rendering as undifferentiated grey since it was written. The prop looked
 * right and did nothing.
 *
 * The grammar is deliberately small. A raw exchange has four things worth
 * telling apart - the request line, the status line, header names, and the body
 * after the blank line - and Monarch's `root` state plus one `body` state covers
 * exactly that. Anything more (guessing at JSON inside the body, say) would be a
 * second highlighter fighting whatever the body actually is.
 */

import type * as Monaco from "monaco-editor";

export const HTTP_LANGUAGE_ID = "http";

/**
 * Marks where a raw request ends and its response begins.
 *
 * It lives *here*, beside the grammar that has to recognise it, and the Raw tab
 * imports it. The two were separate for one commit and immediately drifted: the
 * separator changed and the grammar kept matching the old one, so the tokenizer
 * never left its `body` state and the whole response half - status line,
 * headers, everything - rendered unhighlighted. Caught by tokenizing a sample
 * exchange in a browser, not by any test.
 *
 * A `#` prefix because a raw exchange has no comment syntax of its own, so
 * anything pasted out of here is obviously annotation rather than protocol.
 */
export const RAW_SEPARATOR = "# ─── response ───";

/**
 * The methods a request line may open with.
 *
 * Anchored so a body line that happens to begin with the word "GET" is not
 * mistaken for a request line - the pattern requires a space and a target after
 * it, and the state machine has already left `root` by then anyway.
 */
const METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT";

/**
 * The separator holds no regex metacharacters today. This keeps that from
 * mattering if it ever changes.
 */
function escapeRegExp(literal: string): string {
	return literal.replace(/[\\^$.*+?()[\]{}|]/g, (ch) => "\\" + ch);
}

export function registerHttpLanguage(monaco: typeof Monaco): void {
	// Registering twice would stack a second tokenizer on the same id; harmless
	// in the app (this module is imported once) but not in tests, which import
	// setup modules per file.
	if (monaco.languages.getLanguages().some((l) => l.id === HTTP_LANGUAGE_ID)) return;

	monaco.languages.register({ id: HTTP_LANGUAGE_ID });

	monaco.languages.setMonarchTokensProvider(HTTP_LANGUAGE_ID, {
		defaultToken: "",
		tokenizer: {
			root: [
				// Status line: HTTP/1.1 200 OK
				[/^(HTTP\/[\d.]+)(\s+)(\d{3})(.*)$/, ["keyword", "", "number", "string"]],
				// Request line: GET /orders HTTP/1.1
				[
					new RegExp(`^(${METHODS})(\\s+)(\\S+)(.*)$`),
					["keyword", "", "string", "comment"],
				],
				// A blank line ends the head and starts the body, exactly as the
				// protocol says. Without this the body's colons would keep matching
				// the header rule.
				[/^\s*$/, "", "@body"],
				// Header: Name: value
				[/^([^:\s]+)(:)(\s*)(.*)$/, ["type", "delimiter", "", "string"]],
			],
			body: [
				/*
				 * The separator returns us to reading protocol rather than payload.
				 * Matched from `RAW_SEPARATOR` rather than a copy of its shape, so
				 * changing the marker cannot leave the grammar behind - which is
				 * exactly what happened when these were two literals.
				 */
				[new RegExp(`^${escapeRegExp(RAW_SEPARATOR)}$`), "comment", "@pop"],
			],
		},
	});
}
