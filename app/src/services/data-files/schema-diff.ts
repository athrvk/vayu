/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A file against the contract its collection declares (issue #599).
 *
 * The declared columns are what the builder will eventually validate
 * `{{data.*}}` against, so a file that does not match them is the one thing a
 * user has to know *before* starting a run - a missing column is an engine-side
 * bind error at iteration 1, and today that is the first anyone hears of it.
 *
 * Both directions are worth saying and only one of them blocks anything:
 *
 * - **Declared but absent** is the one that breaks a run. Every `{{data.x}}`
 *   written against that column reaches the wire unbound.
 * - **Present but undeclared** breaks nothing at all - the row simply carries a
 *   column nobody references. It is reported because it is almost always the
 *   sign of the *other* thing: a contract that has drifted from the file, or a
 *   file that is not the one the contract was declared from.
 *
 * Warnings, never errors: the tab and the dialog both render these beside the
 * preview, and a run with a mismatched file is still the user's to start.
 */

/** Both directions of a file-versus-contract comparison. */
export interface DataSchemaDiff {
	/** Declared columns the file does not carry. */
	missing: string[];
	/** Columns the file carries that the contract does not declare. */
	undeclared: string[];
}

/**
 * Compare a parsed file's columns against a declared contract.
 *
 * An empty `declared` list means the collection declares no contract, which is
 * not a mismatch - it is the absence of one, and both lists come back empty.
 */
export function diffDataSchema(declared: string[], actual: string[]): DataSchemaDiff {
	if (declared.length === 0) return { missing: [], undeclared: [] };
	const actualSet = new Set(actual);
	const declaredSet = new Set(declared);
	return {
		missing: declared.filter((column) => !actualSet.has(column)),
		undeclared: actual.filter((column) => !declaredSet.has(column)),
	};
}

/** `a, b and c` - the list as a sentence reads it. */
function list(columns: string[]): string {
	if (columns.length <= 1) return columns.join("");
	return `${columns.slice(0, -1).join(", ")} and ${columns[columns.length - 1]}`;
}

/**
 * The diff as the sentences shown beside a preview, or an empty array when the
 * file matches (or when there is no contract to match).
 *
 * Prose rather than a rendered table because these sit in the picker's existing
 * warnings slot, next to the parser's own - one voice for "here is what is odd
 * about this file", whichever layer noticed.
 */
export function describeDataSchemaDiff(declared: string[], actual: string[]): string[] {
	const { missing, undeclared } = diffDataSchema(declared, actual);
	const messages: string[] = [];
	if (missing.length > 0) {
		messages.push(
			`The file is missing ${missing.length === 1 ? "a declared column" : `${missing.length} declared columns`}: ${list(missing)}. A {{data.${missing[0]}}} token has nothing to bind to.`
		);
	}
	if (undeclared.length > 0) {
		messages.push(
			`The file carries ${undeclared.length === 1 ? "a column" : `${undeclared.length} columns`} the contract does not declare: ${list(undeclared)}. Re-declare from this file if it is the one you meant.`
		);
	}
	return messages;
}
