/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The opt-in number cast for CSV and TSV cells (#2540).
 *
 * Newman's `--csv-auto-parse` (`util.isInt` / `util.isFloat` in its
 * `lib/run/options.js`) is looser than this: it also reads `1e3`, `.5` and
 * whitespace-padded cells as numbers. This is the integer and decimal subset,
 * on purpose - those are the shapes a data file means as a number, and every
 * one that is left as text is a cell a user can still read, which a wrong cast
 * is not.
 */

const NUMERIC_CELL = /^([+-]?)(\d+)(?:\.(\d+))?$/;

/**
 * The cell as a number when it is a plain integer or decimal, otherwise the
 * cell unchanged. The caller owns quoting: a quoted cell is never passed in.
 *
 * Leading zeros and trailing fraction zeros are dropped, which is the point of
 * opting in (`007` is `7`, `1.50` is `1.5`). What is never allowed is losing
 * *digits*: a value that would not print back as the digits the file holds
 * stays text, so a 20-digit id (or `0.1000000000000000055511151231257827`)
 * reaches the request as written instead of rounded. An integer must also be a
 * safe one, because 2^53 prints back exactly and still cannot be told from the
 * integers either side of it.
 */
export function castNumericCell(cell: string): number | string {
	const match = NUMERIC_CELL.exec(cell);
	if (!match) return cell;

	const [, , integerDigits, fractionDigits] = match;
	const value = Number(cell);
	if (fractionDigits === undefined)
		return Number.isSafeInteger(value) ? normalizeZero(value) : cell;

	const significantInteger = integerDigits.replace(/^0+(?=\d)/, "");
	const significantFraction = fractionDigits.replace(/0+$/, "");
	const digits =
		significantFraction === ""
			? significantInteger
			: `${significantInteger}.${significantFraction}`;
	return String(Math.abs(value)) === digits ? normalizeZero(value) : cell;
}

/** `-0` is a number the JSON writer spells `0` and `toEqual` tells apart from it. */
function normalizeZero(value: number): number {
	return value === 0 ? 0 : value;
}
