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
		lines.push(`${name} = {`, ...dictLiteral(prepared.body.fields), "}", "");
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
