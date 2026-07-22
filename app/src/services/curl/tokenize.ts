/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Shell-aware tokenizer for pasted curl/wget commands.
 *
 * Splits a command string into argv, honoring the quoting rules that show up in
 * real-world "Copy as cURL" output from browsers and docs:
 *   - single quotes '...'      → literal (no escapes)
 *   - double quotes "..."      → \" and \\ escapes honored
 *   - ANSI-C $'...'            → \n \t \r \' \\ decoded
 *   - line continuations       → backslash + newline (bash) and ^ + newline (cmd)
 *   - leading prompt noise      → "$ " / "> " stripped per line
 *
 * `{{variables}}` are not special - they pass through as plain text.
 *
 * Throws on an unterminated quote so the caller can fall back to a no-op.
 */

export class UnterminatedQuoteError extends Error {
	constructor() {
		super("Unterminated quote in command");
		this.name = "UnterminatedQuoteError";
	}
}

const ANSI_C_ESCAPES: Record<string, string> = {
	n: "\n",
	t: "\t",
	r: "\r",
	"\\": "\\",
	"'": "'",
	'"': '"',
};

/** Strip a leading shell prompt (`$ ` or `> `) from each line. */
function stripPrompts(input: string): string {
	return input
		.split("\n")
		.map((line) => line.replace(/^\s*[$>]\s+/, ""))
		.join("\n");
}

/** Remove line continuations: backslash+newline (bash) and caret+newline (cmd). */
function joinContinuations(input: string): string {
	return input.replace(/\\\r?\n/g, " ").replace(/\^\r?\n/g, " ");
}

export function tokenize(input: string): string[] {
	const src = joinContinuations(stripPrompts(input));
	const tokens: string[] = [];

	let current = "";
	let hasToken = false; // distinguishes "" (empty quoted arg) from no arg
	let i = 0;
	const n = src.length;

	while (i < n) {
		const ch = src[i];

		// Whitespace separates tokens (outside quotes).
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			if (hasToken) {
				tokens.push(current);
				current = "";
				hasToken = false;
			}
			i++;
			continue;
		}

		// ANSI-C quoting: $'...'
		if (ch === "$" && src[i + 1] === "'") {
			hasToken = true;
			i += 2;
			while (i < n && src[i] !== "'") {
				if (src[i] === "\\" && i + 1 < n) {
					const next = src[i + 1];
					current += ANSI_C_ESCAPES[next] ?? next;
					i += 2;
				} else {
					current += src[i];
					i++;
				}
			}
			if (i >= n) throw new UnterminatedQuoteError();
			i++; // closing '
			continue;
		}

		// Single quotes: literal, no escapes.
		if (ch === "'") {
			hasToken = true;
			i++;
			while (i < n && src[i] !== "'") {
				current += src[i];
				i++;
			}
			if (i >= n) throw new UnterminatedQuoteError();
			i++; // closing '
			continue;
		}

		// Double quotes: honor \" and \\ escapes.
		if (ch === '"') {
			hasToken = true;
			i++;
			while (i < n && src[i] !== '"') {
				if (src[i] === "\\" && (src[i + 1] === '"' || src[i + 1] === "\\")) {
					current += src[i + 1];
					i += 2;
				} else {
					current += src[i];
					i++;
				}
			}
			if (i >= n) throw new UnterminatedQuoteError();
			i++; // closing "
			continue;
		}

		// Backslash escape outside quotes.
		if (ch === "\\" && i + 1 < n) {
			hasToken = true;
			current += src[i + 1];
			i += 2;
			continue;
		}

		// Ordinary character.
		hasToken = true;
		current += ch;
		i++;
	}

	if (hasToken) tokens.push(current);
	return tokens;
}
