/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A Monaco language for a raw HTTP exchange, in `curl -v` notation.
 *
 * The Raw tab has always passed `language="http"` to its editor, and there has
 * never been an `http` language to receive it. Monaco ships ~90 basic languages
 * and that is not one of them - checked against
 * `monaco-editor/languages/definitions/`, which has `html`, `hcl` and
 * `handlebars` but nothing HTTP. Monaco falls back to plain text for an unknown
 * id, so the one tab whose entire job is reading a protocol exchange rendered as
 * undifferentiated grey. The prop looked right and did nothing.
 *
 * **Direction is a prefix, not a separator.** `>` for what was sent, `<` for
 * what came back, which is what `curl -v` and HTTPie print and therefore the
 * closest thing to a convention a reader already knows. It replaced a
 * `# ─── response ───` line, and it is better in three ways: every line says
 * which half it belongs to rather than only the boundary saying it, a pasted
 * excerpt stays unambiguous even when the boundary is not included, and the
 * grammar no longer has to keep a separator string in step with the component
 * that writes it - which it had already failed to do once.
 *
 * **Where this departs from curl:** curl prefixes the head and prints the body
 * bare, because its body goes to stdout for piping. Nothing here is piped, and
 * the payload you want to copy has its own tab with its own copy button, so
 * every line carries its marker - which means an exchange pasted into an issue
 * survives being quoted, reflowed, and read out of order.
 */

import type { MonacoApi } from "./monaco-api";

export const HTTP_LANGUAGE_ID = "http";

/** What was sent. */
export const SENT_MARKER = ">";
/** What came back. */
export const RECEIVED_MARKER = "<";

/**
 * The methods a request line may open with.
 *
 * Anchored behind a marker and followed by a target, so a body line that begins
 * with the word "GET" is not mistaken for a request line.
 */
const METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT";

/**
 * Prefixes every line of one half of the exchange.
 *
 * **A bare marker appears wherever a blank line separates a head from a body,
 * and nowhere else.** That falls out of dropping only *trailing* whitespace: the
 * `\r\n\r\n` between a head and its body is mid-string and survives, while the
 * one terminating a bodyless request is at the end and does not.
 *
 * So a POST shows `>` between its headers and its payload, and a GET shows no
 * bare `>` at all - it has no body for one to separate. curl prints that line
 * either way; this does not, and the difference is deliberate. An earlier
 * version of this comment claimed the trailing blank was "dropped and re-added
 * as a bare marker", which the code has never done - checked by running it
 * against a real GET, where the request head runs straight into the response's
 * status line with nothing between.
 */
export function markLines(text: string, marker: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/\s+$/, "")
		.split("\n")
		.map((line) => `${marker} ${line}`.trimEnd())
		.join("\n");
}

export function registerHttpLanguage(monaco: MonacoApi): void {
	// Registering twice would stack a second tokenizer on the same id; harmless
	// in the app (this module is imported once) but not in tests, which import
	// setup modules per file.
	if (monaco.languages.getLanguages().some((l) => l.id === HTTP_LANGUAGE_ID)) return;

	monaco.languages.register({ id: HTTP_LANGUAGE_ID });

	monaco.languages.setMonarchTokensProvider(HTTP_LANGUAGE_ID, {
		defaultToken: "",
		tokenizer: {
			/*
			 * `root` reads a head - request line, status line, headers. A bare
			 * marker is the blank line that ends one, and moves to `body`.
			 *
			 * The state exists for one reason: a JSON body line like
			 * `< {"a":1}` matches the header rule, because `{"a"` is a plausible
			 * field name followed by a colon. Without a body state the payload
			 * highlights as headers.
			 */
			root: [
				// < HTTP/1.1 200 OK
				[
					/^(<)(\s+)(HTTP\/[\d.]+)(\s+)(\d{3})(.*)$/,
					["comment", "", "keyword", "", "number", "string"],
				],
				// > GET /orders HTTP/1.1
				[
					new RegExp(`^(>)(\\s+)(${METHODS})(\\s+)(\\S+)(.*)$`),
					["comment", "", "keyword", "", "string", "comment"],
				],
				// > Host: api.example.com   /   < Content-Type: application/json
				[
					/^([<>])(\s+)([^:\s]+)(:)(\s*)(.*)$/,
					["comment", "", "type", "delimiter", "", "string"],
				],
				// A bare marker: the blank line between head and body.
				[/^[<>]\s*$/, "comment", "@body"],
			],
			body: [
				/*
				 * A status line ends the request's body and starts the response's
				 * head. This is what the separator used to do, and doing it from
				 * the protocol's own shape means there is no marker string for the
				 * component and the grammar to disagree about.
				 */
				/*
				 * `next` rides on the last group's action, not as a third element of
				 * the rule. Monarch accepts `[regex, action, next]` only when the
				 * action is a single token; with a per-group array the third element
				 * is ignored, so the state never popped and every response header
				 * after the status line fell through to the catch-all below as a
				 * bare comment. Verified by tokenizing, not by reading the docs.
				 */
				[
					/^(<)(\s+)(HTTP\/[\d.]+)(\s+)(\d{3})(.*)$/,
					["comment", "", "keyword", "", "number", { token: "string", next: "@pop" }],
				],
				// Payload lines still show which half they belong to.
				[/^[<>]/, "comment"],
			],
		},
	});
}
