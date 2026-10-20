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
 * (issue #567). What is left is the one helper no table asks for: the ordered
 * header lines the engine's execute and compose endpoints take.
 */

import type { HeaderLine, KeyValueEntry, KeyValueItem } from "@/types";

/**
 * A key without the spaces and tabs around it, which is all the engine trims
 * (`trim_optional_whitespace`). Not `String.prototype.trim`: that also strips
 * newlines and Unicode spaces, which the engine refuses as a bad name instead,
 * so the two would answer differently for the same row.
 */
const headerName = (key: string): string => key.replace(/^[ \t]+|[ \t]+$/g, "");

/**
 * A row that reaches the wire: not switched off (a stored row with no flag is
 * on, as the engine reads it) and naming a header once its padding is trimmed.
 */
const isSentRow = (item: { key: string; enabled?: boolean }): boolean =>
	item.enabled !== false && headerName(item.key) !== "";

/**
 * The Headers table as the engine takes it: every enabled row with a non-empty
 * key, in row order, a repeated name repeated, each in the case it was typed
 * but without the spaces and tabs around it (issues #2466, #2467). A key of
 * other whitespace (a newline) is a name, and the engine refuses it by name
 * rather than the table dropping it quietly. The engine's `stored_header_rows`
 * is the other copy and `engine/tests/fixtures/header-rows-conformance.json`
 * holds the two to one answer (`header-rows.conformance.test.ts`).
 *
 * Never a record: a record keeps one value per key, so `X-Dup` twice, or
 * `Accept` beside `accept`, would send one line, and which one would depend on
 * key order rather than the table. Never for storage either - the rows are what
 * is stored.
 */
export const toHeaderRows = (
	items: ReadonlyArray<Pick<KeyValueEntry, "key" | "value"> & { enabled?: boolean }>
): HeaderLine[] =>
	items.filter(isSentRow).map((item) => ({ name: headerName(item.key), value: item.value }));

/**
 * The names among {@link toHeaderRows}' lines whose last row the body mode wrote
 * (`source: "body-mode"`), as the compose field `bodyModeHeaders` - or nothing
 * when there are none, so a request without one sends the payload it always
 * did.
 *
 * The lines lose the marker, and the engine needs it (issue #1765): a body
 * mode's Content-Type is a system header in Postman's sense, which a stored
 * `content-type` opt-out removes, while a Content-Type the user typed is always
 * sent. A stored request composed by id carries the same list from its stored
 * rows.
 *
 * Names are matched without case, as the engine's `stored_header_rows` does: a
 * typed `content-type` after the body mode's `Content-Type` is the last row for
 * that name, and the name is listed as the first row spelled it, trimmed.
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
