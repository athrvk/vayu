/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Content-Type a `binary` body goes out with, as far as the editor can tell without the engine.
 * The engine's order: an enabled `Content-Type` row, the file's own `contentType`, a type from the
 * extension, then `application/octet-stream`, an empty string counting as absent at every tier. The
 * first two are the request's data and are answered exactly. The extension tier is the engine's
 * table (`media_type_for_extension`), deliberately **not** copied: a second table would drift from
 * the one that reaches the wire, so the editor says "from the file extension" instead of guessing.
 */

import type { FileRef, KeyValueItem } from "@/types";

export type BinaryContentType =
	{ from: "header"; value: string } | { from: "file"; value: string } | { from: "extension" };

export function binaryContentType(
	headers: readonly KeyValueItem[],
	file: FileRef | undefined
): BinaryContentType {
	// The last enabled row wins, as a header map built from the rows keeps it.
	let header = "";
	for (const row of headers) {
		if (row.enabled && row.key.trim().toLowerCase() === "content-type" && row.value.trim()) {
			header = row.value.trim();
		}
	}
	if (header) return { from: "header", value: header };
	const own = file?.contentType?.trim();
	if (own) return { from: "file", value: own };
	return { from: "extension" };
}
