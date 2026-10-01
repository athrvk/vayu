/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a `binary` body sent, as a stored trace records it.
 *
 * The engine writes `bodyFile: {fileName, size, sha256}` on the trace's
 * request node when the body was a file - never the bytes, never the path -
 * so a run says which file went out even after the file has changed on disk.
 * The sha256 is what tells two runs of "the same" `a.bin` apart.
 *
 * Read defensively: a stored row is whatever the engine that wrote it wrote,
 * so only members of the right type are kept, and a record with none left is
 * no record.
 */

export interface SentBodyFile {
	fileName?: string;
	size?: number;
	sha256?: string;
}

export function sentBodyFileOf(node: unknown): SentBodyFile | undefined {
	if (!node || typeof node !== "object") return undefined;
	const raw = node as Record<string, unknown>;
	const file: SentBodyFile = {};
	if (typeof raw.fileName === "string" && raw.fileName) file.fileName = raw.fileName;
	if (typeof raw.size === "number" && Number.isFinite(raw.size) && raw.size >= 0) {
		file.size = raw.size;
	}
	if (typeof raw.sha256 === "string" && raw.sha256) file.sha256 = raw.sha256;
	return Object.keys(file).length > 0 ? file : undefined;
}

/** The leading characters of a sha256 a reader compares by eye; the full one is a tooltip. */
export const SHORT_SHA_LENGTH = 12;
