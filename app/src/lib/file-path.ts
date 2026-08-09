/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The last segment of a filesystem path, for either platform's separator.
 *
 * A multipart file part carries a path, and three places need its filename: the
 * editor row's label, and the two importers that turn a foreign path into a
 * part. Those paths come from whichever machine exported the collection, so
 * splitting on the host's separator alone would show a whole Windows path as
 * one long "filename" on Linux. Node's `path.basename` is not available in the
 * renderer, and it would answer for the host platform anyway.
 */
export function fileBaseName(filePath: string): string {
	const trimmed = filePath.trim();
	if (!trimmed) return "";
	const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}
