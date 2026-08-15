/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * JavaScript `fetch`.
 *
 * Every value the request carries becomes a JS string literal, and every one of
 * them goes through `JSON.stringify` - which is exactly the JS string-literal
 * grammar, so quotes, backslashes, newlines and control characters come out
 * escaped and unicode comes out as itself. Hand-rolling the escape table is how
 * generators end up emitting a literal newline inside a `"` and producing a
 * syntax error.
 */

import { prepareRequest } from "./prepare";
import type { CodegenOptions, GeneratedSnippet, SnippetRequest } from "./types";

/** A JS string literal for this value. `JSON.stringify` *is* the escape rule. */
export function jsString(value: string): string {
	return JSON.stringify(value);
}

export function generateFetch(
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
			"The response is an event stream. This snippet reads it with res.text(), which does not return until the stream ends - read res.body with a reader, or use EventSource, to consume events as they arrive."
		);
	}

	// Name plus the *expression* to emit for it, not the raw value: the basic-auth
	// entry is a `btoa(...)` call rather than a literal, and a sentinel prefix on
	// a plain string would misfire on a header value that happened to start with
	// it.
	const headers: Array<{ name: string; expression: string }> = [];
	const isFormData = prepared.body?.kind === "form-data";
	for (const [name, value] of prepared.headers) {
		// `fetch` sets multipart's Content-Type itself, boundary included. Keeping
		// a boundary-less one from the composed request makes the server read the
		// whole body as one part - so it is dropped, and said out loud.
		if (isFormData && name.toLowerCase() === "content-type") {
			notes.push(
				"Content-Type is left to fetch, which adds the multipart boundary it generates."
			);
			continue;
		}
		headers.push({ name, expression: jsString(value) });
	}
	if (prepared.basicAuth) {
		// `btoa` at runtime rather than a precomputed blob: the reader can see
		// which credentials are being sent, and a masked one still reads as a
		// placeholder instead of as opaque base64.
		headers.push({
			name: "Authorization",
			expression: `"Basic " + btoa(${jsString(`${prepared.basicAuth.username}:${prepared.basicAuth.password}`)})`,
		});
	}

	const lines: string[] = [];
	let bodyExpression: string | null = null;

	if (prepared.body?.kind === "raw") {
		bodyExpression = jsString(prepared.body.content);
	} else if (prepared.body) {
		const ctor = prepared.body.kind === "form-data" ? "FormData" : "URLSearchParams";
		lines.push(`const body = new ${ctor}();`);
		for (const [key, value] of prepared.body.fields) {
			lines.push(`body.append(${jsString(key)}, ${jsString(value)});`);
		}
		if (prepared.body.kind === "form-data") {
			for (const file of prepared.body.files) {
				// A path is not something `fetch` can open - the browser has no
				// filesystem, and Node needs `openAsBlob`. So the part is a
				// commented placeholder naming the file, never a silently absent
				// one, and the note says the snippet is incomplete without it.
				lines.push(
					`// ${file.key}: attach ${file.path} as a File/Blob before sending`,
					`// body.append(${jsString(file.key)}, fileBlob, ${jsString(file.fileName || file.key)});`
				);
			}
			if (prepared.body.files.length > 0) {
				notes.push(
					`fetch cannot read a local path: ${prepared.body.files
						.map((f) => f.key)
						.join(", ")} must be attached as a File or Blob.`
				);
			}
		}
		lines.push("");
		bodyExpression = "body";
	}

	const init: string[] = [`\tmethod: ${jsString(prepared.method)},`];
	if (headers.length > 0) {
		init.push("\theaders: {");
		for (const { name, expression } of headers) {
			init.push(`\t\t${jsString(name)}: ${expression},`);
		}
		init.push("\t},");
	}
	if (bodyExpression) init.push(`\tbody: ${bodyExpression},`);

	lines.push(
		`const response = await fetch(${jsString(prepared.url)}, {`,
		...init,
		"});",
		"",
		"console.log(response.status, await response.text());"
	);

	return { code: lines.join("\n"), notes, masked: prepared.masked };
}
