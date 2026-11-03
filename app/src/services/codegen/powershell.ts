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

import { fileBaseName } from "@/lib/file-path";
import {
	foldRepeatedHeaders,
	prepareRequest,
	timeoutSeconds,
	untypedTextPartNote,
	type PreparedFilePart,
	type PreparedPart,
	type PreparedRequest,
	type PreparedTextPart,
} from "./prepare";
import type { CodegenOptions, GeneratedSnippet, SnippetRequest } from "./types";

/** A literal PowerShell string. The one escape is a doubled single quote. */
export function powerShellQuote(value: string): string {
	return `'${value.split("'").join("''")}'`;
}

/**
 * The parameters for the settings Invoke-RestMethod takes per call. Redirects
 * follow by default, as in Vayu, so the cap is written only for a following
 * request that names one, and `0` is how following is turned off.
 */
function transferParams(prepared: PreparedRequest): string[] {
	const params: string[] = [];
	if (!prepared.followRedirects) params.push("-MaximumRedirection 0");
	else if (prepared.maxRedirects !== null) {
		params.push(`-MaximumRedirection ${prepared.maxRedirects}`);
	}
	if (!prepared.verifySSL) params.push("-SkipCertificateCheck");
	if (prepared.timeoutMs !== null) {
		// Whole seconds only, so a sub-second or fractional timeout rounds up: a
		// deadline that fires early would fail a request Vayu lets finish.
		params.push(`-TimeoutSec ${Math.max(1, Math.ceil(timeoutSeconds(prepared.timeoutMs)))}`);
	}
	return params;
}

/**
 * One `-Form` hashtable entry. `-Form` uploads a FileInfo as a file part;
 * `Get-Item` is how the docs produce one. `-LiteralPath` so a path containing
 * `[` or `]` is not read as a wildcard and silently matches nothing.
 */
function formEntry(part: PreparedPart): string {
	const value =
		part.kind === "text"
			? powerShellQuote(part.value)
			: `Get-Item -LiteralPath ${powerShellQuote(part.path)}`;
	return `    ${powerShellQuote(part.key)} = ${value}`;
}

/**
 * The names that appear more than once, spelled as at their first repeat. A
 * hashtable literal (`-Form`, or a urlencoded `-Body`) keeps one entry per name
 * and compares names without regard to case, so `tag` and `Tag` collide as
 * well; a literal that repeats one does not parse (#3206, #3216).
 */
function repeatedNames(names: readonly string[]): string[] {
	const seen = new Set<string>();
	const repeated = new Map<string, string>();
	for (const name of names) {
		const folded = name.toLowerCase();
		if (seen.has(folded) && !repeated.has(folded)) repeated.set(folded, name);
		seen.add(folded);
	}
	return [...repeated.values()];
}

/** The body's repeated field or part names; none for the modes that have no fields. */
function repeatedBodyNames(body: PreparedRequest["body"]): string[] {
	if (body?.kind === "form-data") return repeatedNames(body.parts.map((part) => part.key));
	if (body?.kind === "urlencoded") return repeatedNames(body.fields.map(([key]) => key));
	return [];
}

/**
 * One urlencoded component as the engine writes it (`curl_easy_escape`): every
 * byte outside RFC 3986's unreserved set is `%XX`, a space included. Not
 * `encodeURIComponent`, which leaves `!'()*` raw.
 */
function percentEncodeComponent(text: string): string {
	return Array.from(new TextEncoder().encode(text), (byte) => {
		const char = String.fromCharCode(byte);
		return /[A-Za-z0-9\-._~]/.test(char)
			? char
			: `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}).join("");
}

/** A urlencoded body as the one string the engine puts on the wire, in row order. */
function encodedFormString(fields: Array<[string, string]>): string {
	return fields
		.map(([key, value]) => `${percentEncodeComponent(key)}=${percentEncodeComponent(value)}`)
		.join("&");
}

/**
 * The statements that give `$part` its Content-Type, when the part declares one.
 * Left unset otherwise: a text part goes out untyped, as the engine sends it.
 */
function contentTypeLines(contentType: string | undefined): string[] {
	if (!contentType) return [];
	return [
		`$part.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse(${powerShellQuote(contentType)})`,
	];
}

function textContentLines({ key, value, contentType }: PreparedTextPart): string[] {
	return [
		`$part = [System.Net.Http.ByteArrayContent]::new([Text.Encoding]::UTF8.GetBytes(${powerShellQuote(value)}))`,
		...contentTypeLines(contentType),
		`$body.Add($part, ${powerShellQuote(key)})`,
	];
}

/** As in `formEntry`, `-LiteralPath` keeps `[` and `]` in a path from being a wildcard. */
function fileContentLines(file: PreparedFilePart): string[] {
	const fileName = file.fileName || fileBaseName(file.path);
	return [
		`$part = [System.Net.Http.StreamContent]::new((Get-Item -LiteralPath ${powerShellQuote(file.path)}).OpenRead())`,
		...contentTypeLines(file.contentType),
		`$body.Add($part, ${powerShellQuote(file.key)}, ${powerShellQuote(fileName)})`,
	];
}

function contentBodyNotes(parts: PreparedPart[], repeatedKeys: string[]): string[] {
	const notes = [
		`Parts named ${repeatedKeys.join(", ")} repeat, which a -Form hashtable cannot hold, so the parts are built as a MultipartFormDataContent and passed as -Body.`,
	];
	const files = parts.filter((part) => part.kind === "file");
	if (files.length > 0) {
		notes.push("File streams are opened inline and left for the shell to close.");
	}
	if (files.some((file) => !file.contentType)) {
		notes.push(
			"A file part with no declared Content-Type is sent without one; Vayu derives it from the file's extension."
		);
	}
	return notes;
}

/**
 * A multipart body as a `MultipartFormDataContent`, which `Invoke-RestMethod`
 * takes as `-Body` and which, unlike a `-Form` hashtable, can hold several
 * parts under one name. It adds the boundary and the matching Content-Type
 * itself, as `-Form` does.
 */
function multipartContentLines(parts: PreparedPart[]): string[] {
	return [
		"$body = [System.Net.Http.MultipartFormDataContent]::new()",
		...parts.flatMap((part) =>
			part.kind === "file" ? fileContentLines(part) : textContentLines(part)
		),
	];
}

export function generatePowerShell(
	request: SnippetRequest,
	options: CodegenOptions = {}
): GeneratedSnippet {
	const prepared = prepareRequest(request, options);
	const notes = [...prepared.notes];
	// The one parameter above that the shell this target exists for lacks.
	if (!prepared.verifySSL) {
		notes.push(
			"-SkipCertificateCheck needs PowerShell 6 or later. Windows PowerShell 5.1 does not have it."
		);
	}
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
	const repeatedKeys = repeatedBodyNames(prepared.body);
	const folded = foldRepeatedHeaders(prepared.headers, "Invoke-RestMethod");
	notes.push(...folded.notes);
	for (const [name, value] of folded.headers) {
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
		// place the reader is already looking. The content form (repeated part
		// names) keeps the same floor rather than claim an older shell.
		lines.push(
			repeatedKeys.length > 0
				? "# requires PowerShell 6.1+ (MultipartFormDataContent as -Body)"
				: "# requires PowerShell 6.1+ (-Form)",
			""
		);
	}

	if (headers.length > 0) {
		lines.push("$headers = @{");
		for (const { name, expression } of headers) {
			lines.push(`    ${powerShellQuote(name)} = ${expression}`);
		}
		lines.push("}", "");
	}

	let bodyParam: string | null = null;
	let inFile: string | null = null;
	let encodedFormContentType: string | null = null;
	if (prepared.body?.kind === "binary") {
		// `-InFile` sends the file as the body; `-Body` would want its bytes
		// read into a variable first.
		inFile = prepared.body.path;
	} else if (prepared.body?.kind === "raw") {
		bodyParam = "-Body $body";
		lines.push(`$body = ${powerShellQuote(prepared.body.content)}`, "");
	} else if (prepared.body?.kind === "form-data" && repeatedKeys.length > 0) {
		bodyParam = "-Body $body";
		lines.push(...multipartContentLines(prepared.body.parts), "");
		notes.push(...contentBodyNotes(prepared.body.parts, repeatedKeys));
	} else if (prepared.body?.kind === "urlencoded" && repeatedKeys.length > 0) {
		bodyParam = "-Body $body";
		// A string -Body is sent as written and the hashtable form is what made the
		// cmdlet urlencode, so the type is named on the call.
		encodedFormContentType = "application/x-www-form-urlencoded";
		lines.push(`$body = ${powerShellQuote(encodedFormString(prepared.body.fields))}`, "");
		notes.push(
			`Fields named ${repeatedKeys.join(", ")} repeat, which a -Body hashtable cannot hold, so the body is passed as one pre-encoded string.`
		);
	} else if (prepared.body) {
		// `-Form` is the multipart switch (PowerShell 6.1+); `-Body` with a
		// hashtable is urlencoded.
		bodyParam = isFormData ? "-Form $body" : "-Body $body";
		// `-Form` writes the parts in the order the hashtable enumerates, which
		// for a plain `@{}` is unspecified. `[ordered]` keeps the row order.
		lines.push(prepared.body.kind === "urlencoded" ? "$body = @{" : "$body = [ordered]@{");
		const untyped = untypedTextPartNote(prepared.body, "Invoke-RestMethod -Form");
		if (untyped) notes.push(untyped);
		if (prepared.body.kind === "urlencoded") {
			for (const [key, value] of prepared.body.fields) {
				lines.push(`    ${powerShellQuote(key)} = ${powerShellQuote(value)}`);
			}
		} else {
			lines.push(...prepared.body.parts.map(formEntry));
			if (prepared.body.parts.some((part) => part.kind === "file")) {
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
	if (inFile !== null) call.push(`-InFile ${powerShellQuote(inFile)}`);
	if (bodyParam) call.push(bodyParam);
	// A declared Content-Type is already in $headers and wins, as it does in Vayu.
	const declaresContentType = headers.some(({ name }) => name.toLowerCase() === "content-type");
	if (encodedFormContentType && !declaresContentType) {
		call.push(`-ContentType ${powerShellQuote(encodedFormContentType)}`);
	}

	call.push(...transferParams(prepared));

	lines.push(call.join(" `\n  "));

	return { code: lines.join("\n"), notes, masked: prepared.masked };
}
