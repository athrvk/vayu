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

import { fileBaseName } from "@/lib/file-path";
import {
	foldRepeatedHeaders,
	headerEncodingNotes,
	prepareRequest,
	timeoutSeconds,
	type PreparedFilePart,
	type PreparedRequest,
	type PreparedTextPart,
} from "./prepare";
import type { CodegenOptions, GeneratedSnippet, SnippetRequest } from "./types";

/** A Python string literal - see the file comment for why JSON's rule fits. */
export function pythonString(value: string): string {
	return JSON.stringify(value);
}

function dictLiteral(entries: Array<[string, string]>, indent = "    "): string[] {
	return entries.map(([key, value]) => `${indent}${pythonString(key)}: ${pythonString(value)},`);
}

/**
 * A list of `(key, value)` pairs, which `data=` and `files=` take in place of a
 * dict. A dict holds one value per key, so a body that sends one name twice
 * (a form field repeated, several files under `attachments`) would write only
 * the last of them (#3206).
 */
function pairListLiteral(entries: Array<[string, string]>): string[] {
	return entries.map(([key, value]) => `    (${pythonString(key)}, ${pythonString(value)}),`);
}

/**
 * A multipart text part as a `files` pair: requests' `(filename, content[,
 * type])` tuple with no filename. A bare string in `files=` is read as a file
 * upload and sent with `filename=<key>`, which a text field must not carry; the
 * `None` filename is the one spelling that keeps it a field, with or without a
 * declared Content-Type.
 */
function textPartEntry({ key, value, contentType }: PreparedTextPart): string {
	const parts = [
		"None",
		pythonString(value),
		...(contentType ? [pythonString(contentType)] : []),
	];
	return `    (${pythonString(key)}, (${parts.join(", ")})),`;
}

/**
 * A multipart file part as a `files` pair. The filename is the declared one,
 * else the path's basename - what the engine sends. A declared Content-Type is
 * written; otherwise it is left out so requests guesses it from that filename,
 * as the engine does from the extension.
 */
function filePartEntry(file: PreparedFilePart): string {
	const parts = [
		pythonString(file.fileName || fileBaseName(file.path)),
		`open(${pythonString(file.path)}, "rb")`,
		...(file.contentType ? [pythonString(file.contentType)] : []),
	];
	return `    (${pythonString(file.key)}, (${parts.join(", ")})),`;
}

/**
 * The keyword arguments for the settings requests spells per call. Redirects
 * follow by default, as in Vayu, so only the off case is written; a following
 * request's hop cap has no argument and is a note (`transferNotes`).
 */
function transferArgs(prepared: PreparedRequest): string[] {
	const args: string[] = [];
	if (!prepared.followRedirects) args.push("    allow_redirects=False,");
	if (!prepared.verifySSL) args.push("    verify=False,");
	// Seconds, decimals allowed. requests applies it to the connect and to each
	// read rather than to the whole transfer.
	if (prepared.timeoutMs !== null)
		args.push(`    timeout=${timeoutSeconds(prepared.timeoutMs)},`);
	return args;
}

function transferNotes(prepared: PreparedRequest): string[] {
	if (prepared.maxRedirects === null) return [];
	return [
		`requests has no per-request redirect limit, so it follows up to 30 hops where this request allows ${prepared.maxRedirects}. Set max_redirects on a requests.Session to match.`,
	];
}

export function generatePython(
	request: SnippetRequest,
	options: CodegenOptions = {}
): GeneratedSnippet {
	const prepared = prepareRequest(request, options);
	const notes = [
		...prepared.notes,
		...headerEncodingNotes(prepared, "requests"),
		...transferNotes(prepared),
	];
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
	const folded = foldRepeatedHeaders(prepared.headers, "requests");
	notes.push(...folded.notes);
	for (const [name, value] of folded.headers) {
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
	} else if (prepared.body?.kind === "binary") {
		// A file object as `data=`, which requests streams as the body - the
		// same left-open handle a file part uses, said the same way.
		callArgs.push(`    data=open(${pythonString(prepared.body.path)}, "rb"),`);
		notes.push("The file handle is opened inline and left for the interpreter to close.");
	} else if (prepared.body) {
		const name = prepared.body.kind === "form-data" ? "files" : "data";
		const entries =
			prepared.body.kind === "form-data"
				? prepared.body.parts.map((part) =>
						part.kind === "file" ? filePartEntry(part) : textPartEntry(part)
					)
				: pairListLiteral(prepared.body.fields);
		// requests spells a file part as a tuple: (filename, fileobj, type). The
		// handles are deliberately not closed - a pasted snippet is one call, and
		// a `with` block per file would bury the request in scaffolding. Said out
		// loud rather than left to be noticed.
		if (
			prepared.body.kind === "form-data" &&
			prepared.body.parts.some((p) => p.kind === "file")
		) {
			notes.push("File handles are opened inline and left for the interpreter to close.");
		}
		lines.push(`${name} = [`, ...entries, "]", "");
		// `files=` is what makes requests send multipart; `data=` with a list of
		// pairs is urlencoded. A multipart body passed as `data=` is silently urlencoded,
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
	callArgs.push(...transferArgs(prepared));

	lines.push(
		"response = requests.request(",
		...callArgs,
		")",
		"",
		"print(response.status_code, response.text)"
	);

	return { code: lines.join("\n"), notes, masked: prepared.masked };
}
