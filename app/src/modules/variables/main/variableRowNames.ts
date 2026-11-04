/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which variable-table rows cannot be written under the name they carry, and why (#3251).
 *
 * The engine refuses a variable name that is blank or differs from its trim
 * (`is_addressable_variable_name`), and the payload is a map keyed by name, so a
 * second row with the same name would silently replace the first. Both are
 * decided here, on trimmed names, so the editor never builds a payload the
 * engine would refuse or fold.
 */

import type { VariableRowData } from "./VariableTableEditor";

export type NameProblem = "unnamed" | "duplicate";

export const NAME_PROBLEM_MESSAGE: Record<NameProblem, string> = {
	unnamed: "Needs a name",
	duplicate: "Name already used",
};

// The engine's `trim_variable_name` cuts exactly these four. `String.trim`
// also cuts a no-break space, which the engine keeps, so it cannot stand in.
const NAME_PADDING = /^[ \t\r\n]+|[ \t\r\n]+$/g;

export function trimVariableName(name: string): string {
	return name.replace(NAME_PADDING, "");
}

/** Whether the engine accepts `name` as a stored variable name (`is_addressable_variable_name`). */
export function isAddressableName(name: string): boolean {
	return name !== "" && trimVariableName(name) === name;
}

/**
 * The rows that cannot be saved as they stand, by row id; a row absent from the
 * map is fine.
 *
 * The trailing blank row is never a problem: it is a placeholder. A row that
 * has been promoted (something was typed into it) or that came from the server
 * and now has no name is `unnamed`. Of the rows spelling one name, the one the
 * server already stores under it (`baseKey`) keeps it, so renaming `token` to
 * an existing `host` flags the renamed row rather than the untouched one; with
 * no such row the first in table order keeps it.
 */
export function nameProblems(rows: readonly VariableRowData[]): Map<string, NameProblem> {
	const problems = new Map<string, NameProblem>();
	const holders = new Map<string, string>();

	rows.forEach((row) => {
		const name = trimVariableName(row.key);
		if (row.baseKey !== undefined && name === row.baseKey) holders.set(name, row.id);
	});

	rows.forEach((row) => {
		const name = trimVariableName(row.key);
		if (name === "") {
			if (!row.isNew) problems.set(row.id, "unnamed");
			return;
		}
		const holder = holders.get(name);
		if (holder === undefined) holders.set(name, row.id);
		else if (holder !== row.id) problems.set(row.id, "duplicate");
	});

	return problems;
}

/** `rows` with every name trimmed; the same array when none needed it. */
export function withTrimmedNames(rows: VariableRowData[]): VariableRowData[] {
	if (rows.every((row) => trimVariableName(row.key) === row.key)) return rows;
	return rows.map((row) => {
		const key = trimVariableName(row.key);
		return key === row.key ? row : { ...row, key };
	});
}
