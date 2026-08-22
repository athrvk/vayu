/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * How one data-file cell is spelled on screen.
 *
 * A row's values are `unknown` - CSV and TSV produce strings, JSON and JSONL
 * keep their native types (see `index.ts`) - so every surface that shows a cell
 * has to answer the same four questions: a string is itself, absent is blank, an
 * object or array is compact JSON, and anything else is `String()`.
 *
 * It lives here because two surfaces show these cells and used to answer
 * separately: the Run dialog's file preview (`DataFilePicker`) and the row
 * picker beside Send (`SendWithRowDialog`, issue #892). Same file, same rows -
 * so a `null` rendering as `""` in one and `"null"` in the other would be two
 * descriptions of one thing.
 *
 * This is what a value *reads* as. The engine has its own copy of the question
 * for the wire (`vayu::http::render_data_value`), and the two differ on purpose:
 * a nested object is compact JSON in both, but the engine's answer is what gets
 * substituted into a request and this one only has to be legible.
 */
export function dataCellText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}
