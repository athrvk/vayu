/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Execution-shaped key/value helpers: the ordered header lines the engine's execute and compose
 * endpoints take. The row model (`createEmptyKeyValue`, `withTrailingBlank`, `toKeyValueItems`,
 * `toKeyValueEntries`) lives with its table in `components/shared/KeyValueEditor/key-value.ts`
 * (#567).
 */

import type { HeaderLine, KeyValueEntry, KeyValueItem } from "@/types";

/**
 * A key without surrounding spaces and tabs, all the engine trims (`trim_optional_whitespace`). Not
 * `String.prototype.trim`, which also strips newlines and Unicode spaces the engine refuses as a
 * bad name, so the two would disagree on one row.
 */
const headerName = (key: string): string => key.replace(/^[ \t]+|[ \t]+$/g, "");

/**
 * A row reaching the wire: not off (a stored row with no flag is on, as the engine reads it) and
 * naming a header once trimmed.
 */
const isSentRow = (item: { key: string; enabled?: boolean }): boolean =>
	item.enabled !== false && headerName(item.key) !== "";

/**
 * The Headers table as the engine takes it: every enabled row with a non-empty key, in row order,
 * repeats repeated, each in its typed case but without surrounding spaces and tabs (#2466, #2467).
 * A key of other whitespace (a newline) is a name, refused by the engine by name rather than
 * dropped here. The engine's `stored_header_rows` is the other copy, and
 * `engine/tests/fixtures/header-rows-conformance.json` holds the two to one answer
 * (`header-rows.conformance.test.ts`). Never a record (one value per key would send `X-Dup` once,
 * or one of `Accept` / `accept`, by key order), and never for storage: the rows are stored.
 */
export const toHeaderRows = (
	items: ReadonlyArray<Pick<KeyValueEntry, "key" | "value"> & { enabled?: boolean }>
): HeaderLine[] =>
	items.filter(isSentRow).map((item) => ({ name: headerName(item.key), value: item.value }));

/**
 * The names among {@link toHeaderRows}' lines whose last row the body mode wrote
 * (`source: "body-mode"`), as the compose field `bodyModeHeaders`, or nothing, so a request without
 * one sends what it always did. The lines lose the marker, which the engine needs (#1765): a body
 * mode's Content-Type is a Postman system header a stored `content-type` opt-out removes, while a
 * typed one always goes. A request composed by id carries the same list from its rows. Names match
 * without case, as `stored_header_rows` does: a typed `content-type` after the body mode's
 * `Content-Type` is that name's last row, listed as its first row spelled it, trimmed.
 */
export const bodyModeHeaders = (items: KeyValueItem[]): { bodyModeHeaders?: string[] } => {
	const marked = new Map<string, { name: string; isBodyMode: boolean }>();
	items.forEach((item) => {
		if (isSentRow(item)) {
			const name = headerName(item.key);
			const folded = name.toLowerCase();
			marked.set(folded, {
				name: marked.get(folded)?.name ?? name,
				isBodyMode: item.source === "body-mode",
			});
		}
	});
	const names = [...marked.values()].filter((m) => m.isBodyMode).map((m) => m.name);
	return names.length > 0 ? { bodyModeHeaders: names } : {};
};
