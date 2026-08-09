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
			// `--form-string`, not `-F`: `-F` reads a value beginning with `@` or
			// `<` as a file reference and `;type=` as a per-part override, so a
			// generated command would upload a local file the request never
			// contained. `--form-string` takes the value literally, always.
			args.push(`--form-string ${shellQuote(`${key}=${value}`)}`);
		}
		for (const file of prepared.body.files) {
			// A file part is the one case where `-F` is right: `@path` is exactly
			// what it means here, and the two modifiers carry the part's declared
			// name and type. This is the inverse of what `parseCurl` reads back.
			const modifiers = [
				file.contentType ? `;type=${file.contentType}` : "",
				file.fileName ? `;filename=${file.fileName}` : "",
			].join("");
			args.push(`-F ${shellQuote(`${file.key}=@${file.path}${modifiers}`)}`);
		}
	} else if (prepared.body?.kind === "urlencoded") {
		for (const [key, value] of prepared.body.fields) {
			// curl encodes only what follows the first `=`, so the field *name* has
			// to arrive already encoded: a raw space, `&` or `=` in it sends a
			// different field than the request carries, and a raw `@` hits curl's
			// `name@file` form and reads a local file. Encoding the name here and
			// leaving the value to curl is the split curl documents; the `%20` for a
			// space matches what curl emits on the value side.
			args.push(`--data-urlencode ${shellQuote(`${encodeURIComponent(key)}=${value}`)}`);
		}
	}

	return {
		code: args.join(" \\\n  "),
		notes: prepared.notes,
		masked: prepared.masked,
	};
}
