/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * An RFC 4180 tokenizer for CSV and TSV (issue #402).
 *
 * Hand-rolled, and deliberately so: this is the codebase's first tabular
 * primitive, a dependency for it would be the only parser in `services/` that
 * is not ours, and the grammar it has to cover is small and fully specified -
 * quoted fields, doubled quotes inside them, embedded newlines and commas, and
 * CRLF. What a library would add here is surface, not correctness.
 *
 * TSV is the same grammar with a tab delimiter, not a second parser. The two
 * differ in one character, and a separate split-on-tab implementation is
 * exactly the "hand-rolled copy of a primitive" this repo keeps finding: it
 * would silently lose quoting the first time a cell contained one.
 *
 * The tokenizer's only job is text to a grid. Header rules, blank rows and
 * typing all live in `index.ts`, where they are shared with the JSON paths.
 */

/** One physical row of cells, before any header or shape rule is applied. */
export type TabularRow = string[];

/**
 * Split @p text into rows of cells on @p delimiter.
 *
 * A quoted field may contain the delimiter, a newline, and a literal quote
 * written as `""`. A quote that opens a field is structural; one that appears
 * mid-field (`a"b`) is a literal character, which is what a spreadsheet export
 * of a value containing an inch mark produces.
 *
 * The final row is emitted even without a trailing newline, and a single
 * trailing newline does not produce a phantom empty row.
 */
export function parseDelimited(text: string, delimiter: string): TabularRow[] {
	const rows: TabularRow[] = [];
	let row: TabularRow = [];
	let field = "";
	let inQuotes = false;
	// Distinguishes "no cell has started on this row" from "the current cell is
	// empty", which is what keeps a trailing newline from adding a row while a
	// line reading `a,` still yields two cells.
	let rowStarted = false;

	const endField = () => {
		row.push(field);
		field = "";
	};
	const endRow = () => {
		endField();
		rows.push(row);
		row = [];
		rowStarted = false;
	};

	for (let i = 0; i < text.length; i++) {
		const char = text[i];

		if (inQuotes) {
			if (char === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += char;
			}
			continue;
		}

		if (char === '"' && field === "") {
			inQuotes = true;
			rowStarted = true;
			continue;
		}
		if (char === delimiter) {
			rowStarted = true;
			endField();
			continue;
		}
		if (char === "\r") {
			// CRLF and a lone CR both end the row; the LF is consumed with it so
			// a Windows export does not gain an empty row between every line.
			if (text[i + 1] === "\n") i++;
			endRow();
			continue;
		}
		if (char === "\n") {
			endRow();
			continue;
		}
		rowStarted = true;
		field += char;
	}

	if (rowStarted || field !== "" || row.length > 0) endRow();
	return rows;
}

/**
 * Whether a row carries nothing at all - one empty cell, which is what a blank
 * line tokenizes to. Callers skip these rather than calling them ragged: a
 * trailing blank line is the most ordinary thing a text editor adds to a file.
 */
export function isBlankRow(row: TabularRow): boolean {
	return row.every((cell) => cell.trim() === "");
}
