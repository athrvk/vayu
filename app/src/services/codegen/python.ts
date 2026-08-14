/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Python, via `requests`.
 *
 * String literals come from `JSON.stringify`, which is not a shortcut: JSON's
 * escape set (`\"`, `\\`, `\n`, `\r`, `\t`, `\uXXXX`) is a strict subset of
 * Python 3's, every one of them means the same thing in both, and a `'` needs
 * no escape inside the double quotes it emits. Unicode passes through as
 * itself, which Python 3 source takes as UTF-8. A hand-rolled escape table is
 * how a generator ends up emitting a raw newline inside a `"`.
 */

import { prepareRequest } from "./prepare";
import type { CodegenOptions, GeneratedSnippet, SnippetRequest } from "./types";

/** A Python string literal - see the file comment for why JSON's rule fits. */
export function pythonString(value: string): string {
	return JSON.stringify(value);
}

function dictLiteral(entries: Array<[string, string]>, indent = "    "): string[] {
	return entries.map(([key, value]) => `${indent}${pythonString(key)}: ${pythonString(value)},`);
}

export function generatePython(
	request: SnippetRequest,
	options: CodegenOptions = {}
): GeneratedSnippet {
	const prepared = prepareRequest(request, options);
	const notes = [...prepared.notes];
	// Said rather than emitted: this target's stock idiom buffers the whole
	// body, so a snippet that looked like the request would simply hang on an
	// endless stream. A stated limit is better than a command that stalls.
	if (prepared.stream) {
		notes.push(
			"The response is an event stream. This snippet buffers it; pass stream=True to requests and iterate response.iter_lines() to consume events as they arrive."
		);
	}
	const lines: string[] = ["import requests", ""];

	const headers: Array<[string, string]> = [];
	const isFormData = prepared.body?.kind === "form-data";
	for (const [name, value] of prepared.headers) {
		if (isFormData && name.toLowerCase() === "content-type") {
			notes.push(
				"Content-Type is left to requests, which adds the multipart boundary it generates."
			);
			continue;
		}
		headers.push([name, value]);
	}

	if (headers.length > 0) {
		lines.push("headers = {", ...dictLiteral(headers), "}", "");
	}

	const callArgs = [
		`    ${pythonString(prepared.method)},`,
		`    ${pythonString(prepared.url)},`,
	];
	if (headers.length > 0) callArgs.push("    headers=headers,");

	if (prepared.body?.kind === "raw") {
		// `data=` with a str, so the composed bytes go out unchanged. `json=`
		// would re-serialize a payload that is already serialized.
		lines.push(`data = ${pythonString(prepared.body.content)}`, "");
		callArgs.push("    data=data,");
	} else if (prepared.body) {
		const name = prepared.body.kind === "form-data" ? "files" : "data";
		const entries = dictLiteral(prepared.body.fields);
		if (prepared.body.kind === "form-data") {
			// requests spells a file part as a tuple: (filename, fileobj, type).
			// The handles are deliberately not closed - a pasted snippet is one
			// call, and a `with` block per file would bury the request in
			// scaffolding. Said out loud rather than left to be noticed.
			for (const file of prepared.body.files) {
				const parts = [
					pythonString(file.fileName || file.key),
					`open(${pythonString(file.path)}, "rb")`,
					...(file.contentType ? [pythonString(file.contentType)] : []),
				];
				entries.push(`    ${pythonString(file.key)}: (${parts.join(", ")}),`);
			}
			if (prepared.body.files.length > 0) {
				notes.push("File handles are opened inline and left for the interpreter to close.");
			}
		}
		lines.push(`${name} = {`, ...entries, "}", "");
		// `files=` is what makes requests send multipart; `data=` with a dict is
		// urlencoded. A multipart body passed as `data=` is silently urlencoded,
		// which is the mistake this branch exists to avoid.
		callArgs.push(`    ${name}=${name},`);
	}

	if (prepared.basicAuth) {
		lines.push(
			`auth = (${pythonString(prepared.basicAuth.username)}, ${pythonString(prepared.basicAuth.password)})`,
			""
		);
		callArgs.push("    auth=auth,");
	}

	lines.push(
		"response = requests.request(",
		...callArgs,
		")",
		"",
		"print(response.status_code, response.text)"
	);

	return { code: lines.join("\n"), notes, masked: prepared.masked };
}
