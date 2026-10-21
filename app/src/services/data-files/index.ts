/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Data files - CSV / TSV / JSON / JSONL parsed into the rows a collection run
 * sends on its payload (issue #402).
 *
 * **The app parses; the engine never opens a file.** The script sandbox has no
 * filesystem access by design, and handing the daemon a user-supplied path
 * would be a new trust boundary (traversal, arbitrary reads) bought for a
 * parsing job the app already does well - it owns every import parser. So the
 * rows travel inline on `POST /runs`, bounded engine-side by
 * `maxScenarioDataRows` and `maxScenarioDataBytes`.
 *
 * **The header row IS the mapping.** Column names become `{{data.*}}` tokens
 * and `pm.iterationData` keys, with no remapping step - Postman, JMeter and k6
 * all work this way, and a mapping UI would be a second source of truth for
 * something the file already states. An empty or duplicated header cell is
 * therefore a parse error, not a column nobody can address.
 *
 * **CSV and TSV values are strings, unless the file opts in.** `007` stays
 * `007` and a 20-digit id survives, matching JMeter and k6. `castNumbers` is the
 * per-file opt-in for Newman's reading (#2540): an unquoted integer or decimal
 * cell becomes a number, a quoted one never does (`numeric-cell.ts`). JSON and
 * JSONL keep their native types, because the file said what they were, and
 * ignore the option. The preview states the asymmetry rather than leaving it to
 * be discovered.
 *
 * Everything here is pure: text in, rows out. Reading the file is the caller's
 * (a `FileReader`, exactly as `ImportModal` does it - no Electron dialog IPC),
 * and turning its bytes into that text is {@link decodeDataFile}'s. The one
 * read this layer does own is the *second* one - re-opening the path
 * `data-file-store` remembered - and it lives apart in `read-declared.ts`
 * precisely so this module stays pure.
 */

import { DATA_FILE_MAX_NESTING } from "@/constants/data-files";
import { pluralize } from "@/modules/dashboard/utils/format";
import { DataFileError } from "./errors";
import { castNumericCell } from "./numeric-cell";
import { isBlankRow, tokenizeDelimited } from "./tabular";

export type DataFileFormat = "csv" | "tsv" | "json" | "jsonl";

/** One row: column name to the value a `{{data.column}}` token substitutes. */
export type DataFileRow = Record<string, unknown>;

export interface ParsedDataFile {
	format: DataFileFormat;
	/**
	 * Column names in file order - the header row for CSV/TSV, first-seen key
	 * order for JSON/JSONL. This is what the preview shows as its headings and
	 * what tells a user which `{{data.*}}` tokens exist.
	 */
	columns: string[];
	rows: DataFileRow[];
	/**
	 * Whether CSV/TSV numbers were cast: the setting in force, so the preview and
	 * a run's snapshot can state it. Always `false` for JSON and JSONL, which
	 * ignore the option.
	 */
	castNumbers: boolean;
	/**
	 * Things worth saying that are not failures - skipped blank lines, the
	 * CSV-values-are-strings asymmetry. Shown beside the preview; a warning
	 * never blocks a run, and anything that should is thrown instead.
	 */
	warnings: string[];
}

const EXTENSION_FORMATS: Record<string, DataFileFormat> = {
	csv: "csv",
	tsv: "tsv",
	tab: "tsv",
	json: "json",
	jsonl: "jsonl",
	ndjson: "jsonl",
};

/** Extensions the picker offers, as an `<input accept>` list. */
export const DATA_FILE_ACCEPT = ".csv,.tsv,.tab,.json,.jsonl,.ndjson";

/** A UTF-8 BOM survives `FileReader.readAsText` and would poison column one. */
function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * The file's format: its extension when it has a known one, otherwise a sniff
 * of the content, mirroring how `importers/factory.ts` treats a pasted body.
 *
 * The sniff order matters. A leading `[` is the only shape a JSON data file may
 * take (the engine requires an array), and a leading `{` at top level cannot be
 * that array, so it is JSONL. Only then does the delimiter question arise, and
 * it is decided on the first line: whichever of tab and comma appears more
 * often outside quotes is the delimiter, with comma winning a tie because CSV
 * is the far more common export.
 */
export function detectDataFileFormat(text: string, fileName?: string): DataFileFormat {
	const extension = fileName?.split(".").pop()?.toLowerCase();
	if (extension && EXTENSION_FORMATS[extension]) return EXTENSION_FORMATS[extension];

	const trimmed = stripBom(text).trimStart();
	if (trimmed.startsWith("[")) return "json";
	if (trimmed.startsWith("{")) return "jsonl";

	const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
	const tabs = (firstLine.match(/\t/g) ?? []).length;
	const commas = (firstLine.match(/,/g) ?? []).length;
	return tabs > commas ? "tsv" : "csv";
}

export interface ParseDataFileOptions {
	/**
	 * Read an unquoted integer or decimal CSV/TSV cell as a number (default
	 * `false`). Ignored for JSON and JSONL.
	 */
	castNumbers?: boolean;
}

/**
 * The preview's note about how CSV/TSV values were read. One place, because the
 * wording changes with the setting and the picker's checkbox points at it.
 */
function describeValueReading(castNumbers: boolean): string {
	if (castNumbers) {
		return `Numbers are read as numbers - "007" becomes 7. A quoted value such as "007" stays text.`;
	}
	return `Values are read as text - "007" stays "007". Newman reads unquoted numbers as numbers; turn on "Read numbers as numbers" for that, or use a JSON or JSONL file.`;
}

/** The header row's rules, which are also the `{{data.*}}` namespace's rules. */
function readHeader(cells: string[]): string[] {
	const columns: string[] = [];
	const seen = new Set<string>();
	cells.forEach((cell, index) => {
		const name = cell.trim();
		if (name === "") {
			throw new DataFileError(
				`Column ${index + 1} of the header row has no name. Every column needs one - it is what a {{data.column}} token and pm.iterationData read.`
			);
		}
		if (seen.has(name)) {
			throw new DataFileError(
				`The header row names "${name}" twice. A duplicated column is unaddressable: {{data.${name}}} could mean either one.`
			);
		}
		seen.add(name);
		columns.push(name);
	});
	return columns;
}

function parseTabular(
	text: string,
	delimiter: string,
	warnings: string[],
	castNumbers: boolean
): ParsedDataFile {
	const { cells: grid, quoted } = tokenizeDelimited(text, delimiter);
	const format: DataFileFormat = delimiter === "\t" ? "tsv" : "csv";

	if (grid.length === 0 || (grid.length === 1 && isBlankRow(grid[0]))) {
		throw new DataFileError("The file is empty - there is no header row to read columns from.");
	}

	const columns = readHeader(grid[0]);
	const rows: DataFileRow[] = [];
	let blanks = 0;

	for (let i = 1; i < grid.length; i++) {
		const cells = grid[i];
		if (isBlankRow(cells)) {
			blanks++;
			continue;
		}
		if (cells.length !== columns.length) {
			// Loud, because both directions lose data silently: a short row
			// leaves a token unbound, and a long one drops cells nobody can see.
			throw new DataFileError(
				`Row ${i} has ${cells.length} ${pluralize(cells.length, "value")} but the header names ${columns.length} ${pluralize(columns.length, "column")}.`
			);
		}
		const row: DataFileRow = {};
		columns.forEach((name, index) => {
			const cell = cells[index];
			row[name] = castNumbers && !quoted[i][index] ? castNumericCell(cell) : cell;
		});
		rows.push(row);
	}

	if (blanks > 0) {
		warnings.push(`Skipped ${blanks} blank ${pluralize(blanks, "line")}.`);
	}
	warnings.push(describeValueReading(castNumbers));

	return { format, columns, rows, castNumbers, warnings };
}

/**
 * Whether a parsed JSON value nests more than `limit` levels, a scalar being
 * depth 0 and each array or object one more than its deepest child - the
 * engine's `vayu::json::exceeds_depth`, so both sides refuse the same cells.
 *
 * Iterative on purpose: the input is a file someone else wrote, and a recursive
 * walk of a 100000-level cell is a stack overflow the user sees as a crash.
 */
function exceedsNesting(value: unknown, limit: number): boolean {
	const pending: Array<[unknown, number]> = [[value, 0]];
	while (pending.length > 0) {
		const [node, depth] = pending.pop()!;
		if (node === null || typeof node !== "object") continue;
		if (depth + 1 > limit) return true;
		for (const child of Object.values(node)) pending.push([child, depth + 1]);
	}
	return false;
}

/**
 * A JSON row is only a row if it is an object of name/value pairs, and a cell of
 * it is only bindable if the engine's reader will walk it (#2362).
 */
function assertRowObject(value: unknown, where: string): DataFileRow {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new DataFileError(
			`${where} is ${Array.isArray(value) ? "an array" : value === null ? "null" : typeof value}, not an object of name/value pairs.`
		);
	}
	for (const [column, cell] of Object.entries(value)) {
		if (exceedsNesting(cell, DATA_FILE_MAX_NESTING)) {
			throw new DataFileError(
				`${where}, column "${column}" is nested more than ${DATA_FILE_MAX_NESTING} levels deep.`
			);
		}
	}
	return value as DataFileRow;
}

/** First-seen key order across every row - JSON has no header to read. */
function columnsOf(rows: DataFileRow[]): string[] {
	const columns: string[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			if (!seen.has(key)) {
				seen.add(key);
				columns.push(key);
			}
		}
	}
	return columns;
}

/** How many columns a single warning names before it summarises the rest. */
const UNEVEN_COLUMNS_NAMED = 5;

/**
 * Warn about columns the union has but some rows lack.
 *
 * A CSV cannot get here - a short row is already a refusal - but JSON and JSONL
 * have no header, so `columnsOf` unions the keys and a file whose row 7 dropped
 * `email` previews a full `email` column. Without this, the run starts, six
 * iterations execute, and iteration 7 dies on the engine's missing-column error:
 * exactly the late refusal the picker exists to move earlier.
 *
 * A warning and not an error, because an uneven column may simply go
 * unreferenced - only the collection's steps know whether `{{data.email}}` is
 * ever written, and this layer does not see them.
 */
function warnAboutUnevenColumns(columns: string[], rows: DataFileRow[], warnings: string[]): void {
	const uneven = columns
		.map((column) => ({
			column,
			missing: rows.reduce((n, row) => (column in row ? n : n + 1), 0),
		}))
		.filter((c) => c.missing > 0);
	if (uneven.length === 0) return;

	for (const { column, missing } of uneven.slice(0, UNEVEN_COLUMNS_NAMED)) {
		warnings.push(
			`Column "${column}" is missing from ${missing} of ${rows.length} ${pluralize(rows.length, "row")} - a {{data.${column}}} token will fail on those iterations.`
		);
	}
	const rest = uneven.length - UNEVEN_COLUMNS_NAMED;
	if (rest > 0) {
		warnings.push(
			`${rest} more ${pluralize(rest, "column")} ${rest === 1 ? "is" : "are"} missing from some rows.`
		);
	}
}

/**
 * A `.json` file that is really JSON Lines is a common mistake, and the raw
 * `JSON.parse` error about it ("Unexpected non-whitespace character after JSON
 * at position 12") names nothing a user can act on. If the first line alone is
 * a row object, say so.
 */
function looksLikeJsonLines(text: string): boolean {
	const firstLine = text.split(/\r?\n/).find((line) => line.trim() !== "");
	if (firstLine === undefined) return false;
	try {
		const parsed: unknown = JSON.parse(firstLine);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
	} catch {
		return false;
	}
}

function parseJsonArray(text: string, warnings: string[]): ParsedDataFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		throw new DataFileError(
			`The file is not valid JSON: ${(e as Error).message}${
				looksLikeJsonLines(text)
					? " - this looks like JSON Lines, one object per line. Rename it .jsonl or .ndjson."
					: ""
			}`
		);
	}
	if (!Array.isArray(parsed)) {
		throw new DataFileError(
			`A JSON data file must be an array of row objects (this one is ${parsed === null ? "null" : typeof parsed}).`
		);
	}
	const rows = parsed.map((row, index) => assertRowObject(row, `Row ${index}`));
	const columns = columnsOf(rows);
	warnAboutUnevenColumns(columns, rows, warnings);
	return { format: "json", columns, rows, castNumbers: false, warnings };
}

function parseJsonLines(text: string, warnings: string[]): ParsedDataFile {
	const rows: DataFileRow[] = [];
	let blanks = 0;

	text.split(/\r?\n/).forEach((line, index) => {
		if (line.trim() === "") {
			blanks++;
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (e) {
			// The line number is the point of JSONL's error: the file is one
			// object per line, so "invalid JSON" without one is unactionable.
			throw new DataFileError(`Line ${index + 1} is not valid JSON: ${(e as Error).message}`);
		}
		rows.push(assertRowObject(parsed, `Line ${index + 1}`));
	});

	if (blanks > 0) {
		warnings.push(`Skipped ${blanks} blank ${pluralize(blanks, "line")}.`);
	}
	const columns = columnsOf(rows);
	warnAboutUnevenColumns(columns, rows, warnings);
	return { format: "jsonl", columns, rows, castNumbers: false, warnings };
}

/**
 * Parse a data file's text into rows.
 *
 * Throws `DataFileError` with a message naming the row, line or column at
 * fault. A file that parses to no rows throws too: the engine rejects an empty
 * `data` array (a data set that binds nothing is a mistake, not an empty run),
 * and refusing it here means the user hears it before starting anything.
 */
export function parseDataFile(
	text: string,
	fileName?: string,
	options: ParseDataFileOptions = {}
): ParsedDataFile {
	const source = stripBom(text);
	const format = detectDataFileFormat(source, fileName);
	const warnings: string[] = [];

	const parsed =
		format === "json"
			? parseJsonArray(source, warnings)
			: format === "jsonl"
				? parseJsonLines(source, warnings)
				: parseTabular(
						source,
						format === "tsv" ? "\t" : ",",
						warnings,
						options.castNumbers ?? false
					);

	if (parsed.rows.length === 0) {
		throw new DataFileError(
			"The file has no data rows. A data set that binds nothing is a mistake, not an empty run - run without a file instead."
		);
	}
	if (parsed.columns.length === 0) {
		throw new DataFileError("No columns were found, so no {{data.column}} token could bind.");
	}
	return parsed;
}

/**
 * How many iterations a run will actually perform.
 *
 * With rows and no explicit count, the row count is it (Postman's default).
 * With both, the explicit count wins and the row index wraps - which is the
 * case worth showing before the run, because a user who picks a 500-row file
 * and gets one iteration must see that rather than discover it afterwards.
 * This is the engine's rule (`parse_scenario_request`), stated once here so the
 * pre-run summary cannot describe a different run from the one that happens.
 */
export function resolveIterationCount(
	rowCount: number,
	explicitIterations: number | undefined
): number {
	if (explicitIterations !== undefined) return explicitIterations;
	return rowCount > 0 ? rowCount : 1;
}

export { parseDelimited, tokenizeDelimited, type TabularGrid } from "./tabular";
export { castNumericCell } from "./numeric-cell";
export { DataFileError } from "./errors";
export { decodeDataFile, type DecodedDataFile } from "./decode";
export { sha256Hex } from "./hash";
export { describeRowCapRefusal } from "./row-cap";
export { dataCellText } from "./cell-text";
export {
	diffDataSchema,
	describeDataSchemaDiff,
	describeUnboundReferences,
	type DataSchemaDiff,
} from "./schema-diff";
export { auditDataColumns, type AuditableRequest, type ColumnAudit } from "./column-audit";
