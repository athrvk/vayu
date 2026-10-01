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

/**
 * The folder a filesystem path sits in, for either platform's separator, or
 * `""` when the path names no folder (a bare filename, a `{{var}}` on its own).
 * A root stays a root: `/a.bin` is in `/`, `C:\a.bin` in `C:\`.
 */
export function parentFolder(filePath: string): string {
	const trimmed = filePath.trim();
	const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	if (cut < 0) return "";
	const head = trimmed.slice(0, cut);
	if (head === "") return trimmed[cut];
	if (/^[A-Za-z]:$/.test(head)) return head + trimmed[cut];
	return head;
}

/** Separators unified and no trailing one, so two spellings of a folder compare equal. */
function comparable(p: string): string {
	const unified = p.trim().replace(/\\/g, "/");
	const stripped = unified.length > 1 ? unified.replace(/\/+$/, "") : unified;
	// Drive letters and Windows paths compare case-insensitively.
	return /^[A-Za-z]:/.test(stripped) ? stripped.toLowerCase() : stripped;
}

/**
 * Whether `filePath` lies inside `folder`, compared component by component -
 * `/data/fixtures-old/a.bin` is not under `/data/fixtures`.
 *
 * A **display** answer only. The engine decides what it sends, on canonical
 * paths with symlinks followed; this one compares the text, so the editor can
 * say "already under an allowed folder" without asking. A disagreement shows
 * up as the engine's refusal naming the path, never as a silent send.
 */
export function isUnderFolder(filePath: string, folder: string): boolean {
	const file = comparable(filePath);
	const root = comparable(folder);
	if (!file || !root) return false;
	if (root === "/") return file.startsWith("/") && file !== "/";
	return file.startsWith(root + "/");
}
