/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Execution-shaped key/value helpers.
 *
 * The row-model half of this file - `createEmptyKeyValue`, `withTrailingBlank`,
 * `toKeyValueItems`, `toKeyValueEntries` - moved to
 * `components/shared/KeyValueEditor/key-value.ts` with the table it describes
 * (issue #567). What is left is the one helper no table asks for: the flat
 * header record the engine's execute endpoint takes.
 */

import type { KeyValueItem } from "@/types";

/**
 * Build a flat Record<string,string> from KeyValueItems for HTTP execution.
 * Only enabled rows with non-empty keys are included.
 * Last value wins when duplicate keys exist (allows user headers to override system headers).
 * This is ONLY used for the engine execution endpoint - never for storage.
 */
export const toFlatHeaders = (items: KeyValueItem[]): Record<string, string> => {
	const result: Record<string, string> = {};
	items.forEach((item) => {
		if (item.enabled && item.key.trim()) {
			result[item.key] = item.value;
		}
	});
	return result;
};

/**
 * The names among {@link toFlatHeaders}' keys whose winning row the body mode
 * wrote (`source: "body-mode"`), as the compose field `bodyModeHeaders` - or
 * nothing when there are none, so a request without one sends the payload it
 * always did.
 *
 * The flat record loses the marker, and the engine needs it (issue #1765): a
 * body mode's Content-Type is a system header in Postman's sense, which a
 * stored `content-type` opt-out removes, while a Content-Type the user typed
 * is always sent. A stored request composed by id carries the same list from
 * its stored rows.
 */
export const bodyModeHeaders = (items: KeyValueItem[]): { bodyModeHeaders?: string[] } => {
	const marked = new Map<string, boolean>();
	items.forEach((item) => {
		if (item.enabled && item.key.trim()) {
			marked.set(item.key, item.source === "body-mode");
		}
	});
	const names = [...marked].filter(([, isBodyMode]) => isBodyMode).map(([name]) => name);
	return names.length > 0 ? { bodyModeHeaders: names } : {};
};
