/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * PowerShell, via `Invoke-RestMethod`.
 *
 * A separate target rather than "curl with different quotes", which is the
 * whole reason the issue asked for it that way: PowerShell's quoting rule
 * shares nothing with POSIX. A single-quoted PowerShell string is literal -
 * `$env:PATH` and backticks inside it stay text - and the only escape it has is
 * a doubled quote (`''`). Writing a POSIX `'\''` here produces a backslash in
 * the data and an unterminated string.
 *
 * `Invoke-RestMethod` rather than `curl.exe`: on Windows `curl` is an alias for
 * this cmdlet in Windows PowerShell, so a snippet that says `curl` runs
 * something else than the reader expects.
 */

import { prepareRequest } from "./prepare";
import type { CodegenOptions, GeneratedSnippet, SnippetRequest } from "./types";

/** A literal PowerShell string. The one escape is a doubled single quote. */
export function powerShellQuote(value: string): string {
	return `'${value.split("'").join("''")}'`;
}

export function generatePowerShell(
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
			"The response is an event stream. Invoke-RestMethod buffers it and does not return until the stream ends - use a System.Net.Http.HttpClient with HttpCompletionOption.ResponseHeadersRead to consume events as they arrive."
		);
	}
	const lines: string[] = [];

	const headers: Array<{ name: string; expression: string }> = [];
	const isFormData = prepared.body?.kind === "form-data";
	for (const [name, value] of prepared.headers) {
		if (isFormData && name.toLowerCase() === "content-type") {
			notes.push(
				"Content-Type is left to Invoke-RestMethod, which adds the multipart boundary it generates."
			);
			continue;
		}
		headers.push({ name, expression: powerShellQuote(value) });
	}
	if (prepared.basicAuth) {
		// Not `-Credential`: that wants a PSCredential object built over three
		// more lines, and a pasted snippet should be one runnable block. The
		// encoding is written out so a masked value still reads as a placeholder.
		headers.push({
			name: "Authorization",
			expression: `'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(${powerShellQuote(
				`${prepared.basicAuth.username}:${prepared.basicAuth.password}`
			)}))`,
		});
	}

	if (isFormData) {
		// `-Form` arrived in PowerShell 6.1. Windows PowerShell 5.1 - the shell
		// whose `curl` alias is why this target exists at all - has no such
		// parameter and fails the call outright, so the snippet says so in the one
		// place the reader is already looking.
		lines.push("# requires PowerShell 6.1+ (-Form)", "");
	}

	if (headers.length > 0) {
		lines.push("$headers = @{");
		for (const { name, expression } of headers) {
			lines.push(`    ${powerShellQuote(name)} = ${expression}`);
		}
		lines.push("}", "");
	}

	let bodyVariable: string | null = null;
	if (prepared.body?.kind === "raw") {
		bodyVariable = "$body";
		lines.push(`$body = ${powerShellQuote(prepared.body.content)}`, "");
	} else if (prepared.body) {
		bodyVariable = "$body";
		lines.push("$body = @{");
		for (const [key, value] of prepared.body.fields) {
			lines.push(`    ${powerShellQuote(key)} = ${powerShellQuote(value)}`);
		}
		if (prepared.body.kind === "form-data") {
			for (const file of prepared.body.files) {
				// `-Form` uploads a FileInfo as a file part; `Get-Item` is how the
				// docs produce one. `-LiteralPath` so a path containing `[` or `]`
				// is not read as a wildcard and silently matches nothing.
				lines.push(
					`    ${powerShellQuote(file.key)} = Get-Item -LiteralPath ${powerShellQuote(file.path)}`
				);
			}
			if (prepared.body.files.length > 0) {
				notes.push(
					"Invoke-RestMethod names each file part after the file on disk and sets its Content-Type itself."
				);
			}
		}
		lines.push("}", "");
	}

	const call = [
		"Invoke-RestMethod",
		`-Method ${prepared.method}`,
		`-Uri ${powerShellQuote(prepared.url)}`,
	];
	if (headers.length > 0) call.push("-Headers $headers");
	if (bodyVariable) {
		// `-Form` is the multipart switch (PowerShell 6.1+); `-Body` with a
		// hashtable is urlencoded, and with a string is sent as-is.
		call.push(isFormData ? `-Form ${bodyVariable}` : `-Body ${bodyVariable}`);
	}

	lines.push(call.join(" `\n  "));

	return { code: lines.join("\n"), notes, masked: prepared.masked };
}
