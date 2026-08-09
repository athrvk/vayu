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
import { fileBaseName as baseName } from "@/lib/file-path";
import { prepareRequest } from "./prepare";
import type { CodegenOptions, GeneratedSnippet, SnippetRequest } from "./types";

/**
 * Build a request item HTTPie will read back as the field it was built from.
 *
 * HTTPie splits an item at the *earliest* separator it finds, taking the
 * longest one at that position, and the separators are not just `=`: `=@` reads
 * a local file into the field, `==` makes it a query parameter, `@` uploads a
 * file and `:` writes a header. So an unescaped leading `@` or `=` on the value
 * side silently changes what the item means - the same file-reference hazard
 * curl's `-F` has - and a `:`, `=` or `@` anywhere in the key is read as the
 * separator instead of the one we emit.
 *
 * The fix is HTTPie's documented escape, a backslash before the character that
 * must not be read as a separator; `\` itself is that escape character, so a
 * literal one is doubled or it swallows the character after it. Only a
 * *leading* separator matters on the value side - past the `=` we emit, nothing
 * later is the earliest match - so a JSON value keeps its colons and stays
 * readable.
 */
function httpieItem(key: string, value: string): string {
	const escapedKey = key.replace(/[\\:=@]/g, "\\$&");
	const escapedValue = value
		.split("\\")
		.join("\\\\")
		.replace(/^[:=@]/, "\\$&");
	return `${escapedKey}=${escapedValue}`;
}

export function generateHttpie(
	request: SnippetRequest,
	options: CodegenOptions = {}
): GeneratedSnippet {
	const prepared = prepareRequest(request, options);
	const notes = [...prepared.notes];
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
			args.push(shellQuote(httpieItem(key, value)));
		}
		if (prepared.body.kind === "form-data") {
			for (const file of prepared.body.files) {
				// `key@path` is HTTPie's file item - the separator this key is
				// escaped against everywhere else, used deliberately. HTTPie sends
				// the basename and sniffs the type; a part whose declared name or
				// type differs cannot be expressed, so it is said rather than
				// quietly changed.
				args.push(shellQuote(`${file.key.replace(/[\\:=@]/g, "\\$&")}@${file.path}`));
				const declared = file.fileName && file.fileName !== baseName(file.path);
				if (declared || file.contentType) {
					notes.push(
						`HTTPie names the part after the file on disk: ${file.key} is sent as ${baseName(file.path)}${
							file.contentType
								? ", and its Content-Type is sniffed rather than set"
								: ""
						}.`
					);
				}
			}
		}
	}

	return { code: args.join(" \\\n  "), notes, masked: prepared.masked };
}
