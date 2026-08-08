/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * curl, POSIX shells.
 *
 * Quoting is the whole job. Every value goes inside single quotes, where a
 * shell expands nothing at all, and the one character that cannot appear there
 * - the single quote itself - is closed, escaped and reopened (`'\''`). That
 * covers the cases generators usually get wrong in one rule: `$HOME` and
 * backticks in a body stay literal, a newline inside the quotes is a newline,
 * and unicode passes through untouched.
 *
 * A cmd.exe/PowerShell variant is deliberately a separate target rather than a
 * flag on this one - its quoting rules share nothing with these.
 */

import { prepareRequest } from "./prepare";
import type { CodegenOptions, GeneratedSnippet, SnippetRequest } from "./types";

/** Wrap a value so a POSIX shell passes it through byte for byte. */
export function shellQuote(value: string): string {
	return `'${value.split("'").join(`'\\''`)}'`;
}

export function generateCurl(
	request: SnippetRequest,
	options: CodegenOptions = {}
): GeneratedSnippet {
	const prepared = prepareRequest(request, options);
	const args: string[] = [`curl -X ${prepared.method} ${shellQuote(prepared.url)}`];

	const isFormData = prepared.body?.kind === "form-data";
	for (const [name, value] of prepared.headers) {
		// curl builds the multipart boundary, and a Content-Type that names one
		// it did not choose makes the server read the body as a single part.
		if (isFormData && name.toLowerCase() === "content-type") continue;
		args.push(`-H ${shellQuote(`${name}: ${value}`)}`);
	}

	if (prepared.basicAuth) {
		args.push(
			`-u ${shellQuote(`${prepared.basicAuth.username}:${prepared.basicAuth.password}`)}`
		);
	}

	if (prepared.body?.kind === "raw") {
		// `--data-raw`, not `-d`: `-d` treats a body starting with `@` as a file
		// name, which silently sends the wrong bytes for any payload that begins
		// with one.
		args.push(`--data-raw ${shellQuote(prepared.body.content)}`);
	} else if (prepared.body?.kind === "form-data") {
		for (const [key, value] of prepared.body.fields) {
			args.push(`-F ${shellQuote(`${key}=${value}`)}`);
		}
	} else if (prepared.body?.kind === "urlencoded") {
		for (const [key, value] of prepared.body.fields) {
			args.push(`--data-urlencode ${shellQuote(`${key}=${value}`)}`);
		}
	}

	return {
		code: args.join(" \\\n  "),
		notes: prepared.notes,
		masked: prepared.masked,
	};
}
