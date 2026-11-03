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

import {
	foldRepeatedCookies,
	isBlankHeaderValue,
	prepareRequest,
	timeoutSeconds,
	type PreparedFilePart,
	type PreparedTextPart,
} from "./prepare";
import { autoHeaderToAdd } from "@/modules/request-builder/utils/auto-header";
import { ACCEPT_HEADER, SSE_ACCEPT } from "@/constants/request";
import type { CodegenOptions, GeneratedSnippet, SnippetRequest } from "./types";

/** Wrap a value so a POSIX shell passes it through byte for byte. */
export function shellQuote(value: string): string {
	return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * A multipart text part. `--form-string`, not `-F`: `-F` reads a value
 * beginning with `@` or `<` as a file reference and `;type=` as a per-part
 * override, so a generated command would upload a local file the request never
 * contained. `--form-string` takes the value literally, always.
 */
function textFormFlag({ key, value, contentType }: PreparedTextPart): string {
	if (!contentType) return `--form-string ${shellQuote(`${key}=${value}`)}`;
	// `--form-string` has no modifiers, so a typed text part is the one text case
	// that needs `-F`. A double-quoted value is text to curl whatever it starts
	// with (`"@x"` is the literal `@x`), with `\` and `\"` the only escapes;
	// `;type=` is last so a type carrying `;` parameters is taken whole.
	const quoted = `"${value.replace(/[\\"]/g, "\\$&")}"`;
	return `-F ${shellQuote(`${key}=${quoted};type=${contentType}`)}`;
}

/**
 * A multipart file part - the one case where `-F` is right: `@path` is exactly
 * what it means here, and the two modifiers carry the part's declared name and
 * type. This is the inverse of what `parseCurl` reads back.
 */
function fileFormFlag(file: PreparedFilePart): string {
	const modifiers = [
		file.contentType ? `;type=${file.contentType}` : "",
		file.fileName ? `;filename=${file.fileName}` : "",
	].join("");
	return `-F ${shellQuote(`${file.key}=@${file.path}${modifiers}`)}`;
}

/**
 * One `-H` word. A blank value is `Name;`, curl's spelling for a header sent
 * empty, because `Name: ` asks curl to leave the header out and Vayu sends it.
 * A blank Content-Type is the exception: the engine sends none, which is what
 * the removal spelling also means.
 */
function headerArgument(name: string, value: string): string {
	if (!isBlankHeaderValue(value) || name.toLowerCase() === "content-type") {
		return `${name}: ${value}`;
	}
	return `${name};`;
}

export function generateCurl(
	request: SnippetRequest,
	options: CodegenOptions = {}
): GeneratedSnippet {
	const prepared = prepareRequest(request, options);
	const args: string[] = [`curl -X ${prepared.method} ${shellQuote(prepared.url)}`];

	const isFormData = prepared.body?.kind === "form-data";
	for (const [name, value] of foldRepeatedCookies(prepared.headers)) {
		// curl builds the multipart boundary, and a Content-Type that names one
		// it did not choose makes the server read the body as a single part.
		if (isFormData && name.toLowerCase() === "content-type") continue;
		args.push(`-H ${shellQuote(headerArgument(name, value))}`);
	}

	if (prepared.stream) {
		// `-N` is curl's unbuffered mode, and it is what `parseCurl` reads back
		// as the stream setting - the round trip issue #575 asks for.
		args.push("-N");
		// The header the setting implies, added only where the request declares
		// none: the same rule the app's toggle applies through
		// `autoHeaderToAdd`, so a snippet and the request it came from ask the
		// server for the same thing. A declared Accept - even a different one -
		// is the author's and is emitted above untouched.
		const accept = autoHeaderToAdd(
			ACCEPT_HEADER,
			SSE_ACCEPT,
			prepared.headers.map(([key, value]) => ({ key, value, enabled: true }))
		);
		if (accept) args.push(`-H ${shellQuote(`${ACCEPT_HEADER}: ${accept}`)}`);
	}

	if (!prepared.verifySSL) {
		// Emitted only when verification is off, and `parseCurl` reads it back
		// as the same setting - the round trip issue #706 asks for. The verifying
		// default needs no flag: `curl` verifies unless told otherwise, so
		// emitting nothing is emitting the request.
		args.push("-k");
	}

	if (prepared.followRedirects) {
		// The opposite split from `-k`: curl does NOT follow redirects unless
		// told to, while the engine does by default, so the common case is the
		// one that needs the flag (issue #1445). `parseCurl` reads `-L` back as
		// the same setting.
		args.push("-L");
		// Only beside `-L`: a cap on hops that are never taken says nothing. curl's
		// own cap is 50 and Vayu's default 10, so the flag is worth its line.
		if (prepared.maxRedirects !== null) args.push(`--max-redirs ${prepared.maxRedirects}`);
	}

	// `--max-time` bounds the whole transfer, which is what the request's
	// timeout means; seconds, decimals allowed. Absent states no timeout, so
	// curl's own (none) applies.
	if (prepared.timeoutMs !== null) args.push(`--max-time ${timeoutSeconds(prepared.timeoutMs)}`);

	// `auto` emits nothing: curl negotiates by itself, which is what it means.
	if (prepared.httpVersion === "http1.1") args.push("--http1.1");
	if (prepared.httpVersion === "http2") args.push("--http2");

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
	} else if (prepared.body?.kind === "binary") {
		// `--data-binary @path` sends the file byte for byte; `-d @path` would
		// strip its newlines. The `@` stays outside the quotes so the path is
		// quoted like any other value. Content-Type is already among the headers
		// above: `prepare.ts` always supplies one, because curl's own default for
		// `--data-binary` is `application/x-www-form-urlencoded`.
		args.push(`--data-binary @${shellQuote(prepared.body.path)}`);
	} else if (prepared.body?.kind === "form-data") {
		for (const part of prepared.body.parts) {
			args.push(part.kind === "file" ? fileFormFlag(part) : textFormFlag(part));
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
