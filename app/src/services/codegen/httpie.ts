/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * HTTPie, POSIX shells.
 *
 * Shares curl's quoting - same shell, same rule - but not its argument grammar:
 * HTTPie takes headers as bare `Name:value` words rather than `-H` pairs, and
 * a body as `--raw`.
 *
 * The form modes are where HTTPie differs from every other target here.
 * `--form` alone sends `application/x-www-form-urlencoded`; it only becomes
 * multipart when a field carries a file, which a pasted snippet never does. So
 * a multipart body needs `--multipart` explicitly, or HTTPie would quietly send
 * a urlencoded body for a request Vayu sends as multipart.
 */

import { shellQuote } from "./curl";
import { prepareRequest } from "./prepare";
import type { CodegenOptions, GeneratedSnippet, SnippetRequest } from "./types";

export function generateHttpie(
	request: SnippetRequest,
	options: CodegenOptions = {}
): GeneratedSnippet {
	const prepared = prepareRequest(request, options);
	const args: string[] = [`http ${prepared.method} ${shellQuote(prepared.url)}`];

	const isFormData = prepared.body?.kind === "form-data";
	if (isFormData) args.push("--multipart");

	for (const [name, value] of prepared.headers) {
		// HTTPie sets the multipart Content-Type, boundary included; one that
		// names a boundary it did not choose makes the server read the whole body
		// as a single part.
		if (isFormData && name.toLowerCase() === "content-type") continue;
		args.push(shellQuote(`${name}:${value}`));
	}

	if (prepared.basicAuth) {
		args.push(
			`-a ${shellQuote(`${prepared.basicAuth.username}:${prepared.basicAuth.password}`)}`
		);
	}

	if (prepared.body?.kind === "raw") {
		// `--raw`, so the body goes out byte for byte. HTTPie's `key=value` syntax
		// would build a *new* JSON object instead of sending the one composed.
		args.push(`--raw ${shellQuote(prepared.body.content)}`);
	} else if (prepared.body) {
		if (prepared.body.kind === "urlencoded") args.push("--form");
		for (const [key, value] of prepared.body.fields) {
			args.push(shellQuote(`${key}=${value}`));
		}
	}

	return { code: args.join(" \\\n  "), notes: prepared.notes, masked: prepared.masked };
}
