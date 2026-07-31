/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { ApiError } from "@/services/http-client";
import type { ImportResult } from "./types";

/**
 * The temp id the engine named as the item that broke, whichever error shape the
 * body arrived in.
 *
 * Since issue #173 every engine error is `{"error": {"code", "message", ...}}`
 * and `/import/apply` puts the temp id inside that object. The top-level reading
 * is the shape the engine emitted before that, kept because the app and the
 * engine sidecar are not always updated together - a new app talking to an older
 * engine still names the item rather than silently dropping it.
 */
function failedTempId(error: unknown): string | null {
	if (!(error instanceof ApiError)) return null;
	const body = error.response as { error?: { item?: unknown }; item?: unknown } | undefined;
	const item = body?.error?.item ?? body?.item;
	return typeof item === "string" && item.length > 0 ? item : null;
}

/**
 * The name the user gave the item carrying `tempId`, if it is still in the
 * parsed result.
 *
 * The dialog's `ImportResult` carries temp ids at this point because
 * `assignTempIds` stamps them onto that same object in place, on the way into
 * the mutation. If that ever stops being true the lookup simply misses and the
 * caller falls back to the temp id - a worse message, not a broken one.
 */
function nameOfTempId(result: ImportResult, tempId: string): string | null {
	const inCollection = (collections: ImportResult["collections"]): { name: string } | null => {
		for (const c of collections) {
			if (c.tempId === tempId) return c;
			const request = c.requests.find((r) => r.tempId === tempId);
			if (request) return request;
			const child = inCollection(c.children);
			if (child) return child;
		}
		return null;
	};

	const found =
		inCollection(result.collections) ?? result.environments.find((e) => e.tempId === tempId);
	return found ? found.name : null;
}

/**
 * The text the import dialog shows when an import fails.
 *
 * `/import/apply` is atomic, so a failure names one item and persists nothing -
 * but a temp id (`c1`, `r47`) means nothing to the person who chose the file.
 * Resolving it back to the name they see in the preview is what makes a
 * 500-item import diagnosable; the temp id is the fallback for an item the
 * engine named but the parsed result no longer contains.
 */
export function importFailureMessage(error: unknown, result: ImportResult | null): string {
	const message = (error instanceof Error ? error.message : "") || "Import failed";
	const tempId = failedTempId(error);
	if (!tempId) return message;

	const name = result ? nameOfTempId(result, tempId) : null;
	return `${message} (item: ${name ? `"${name}"` : tempId})`;
}
