/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { nameProblems, trimVariableName, withTrimmedNames } from "./variableRowNames";
import type { VariableRowData } from "./VariableTableEditor";

function row(id: string, key: string, extra: Partial<VariableRowData> = {}): VariableRowData {
	return { id, key, value: "", enabled: true, ...extra };
}

describe("trimVariableName", () => {
	it("cuts the four characters the engine cuts, from both ends", () => {
		expect(trimVariableName(" \t\r\nhost\n\r\t ")).toBe("host");
	});

	it("keeps a no-break space and anything inside the name, as the engine does", () => {
		expect(trimVariableName(" host")).toBe(" host");
		expect(trimVariableName(" my var ")).toBe("my var");
	});

	it("reduces a whitespace-only name to empty", () => {
		expect(trimVariableName(" \t ")).toBe("");
	});
});

describe("nameProblems", () => {
	it("leaves the blank row and well-named rows alone", () => {
		const rows = [row("a", "one", { baseKey: "one" }), row("b", " ", { isNew: true })];
		expect(nameProblems(rows).size).toBe(0);
	});

	it("flags an unnamed row that is not the blank row", () => {
		const rows = [row("a", "  ", { baseKey: "one" }), row("b", "", { isNew: false })];
		expect(nameProblems(rows)).toEqual(
			new Map([
				["a", "unnamed"],
				["b", "unnamed"],
			])
		);
	});

	it("flags the row that took a name over the row the server stores under it", () => {
		const rows = [
			row("a", "host", { baseKey: "token" }),
			row("b", "host", { baseKey: "host" }),
		];
		expect(nameProblems(rows)).toEqual(new Map([["a", "duplicate"]]));
	});

	it("flags the later of two unsaved rows spelling one name", () => {
		const rows = [row("a", "x"), row("b", " x ")];
		expect(nameProblems(rows)).toEqual(new Map([["b", "duplicate"]]));
	});
});

describe("withTrimmedNames", () => {
	it("returns the same array when no name needs it", () => {
		const rows = [row("a", "one")];
		expect(withTrimmedNames(rows)).toBe(rows);
	});

	it("replaces only the rows whose name changed", () => {
		const rows = [row("a", "one"), row("b", "two ")];
		const out = withTrimmedNames(rows);
		expect(out[0]).toBe(rows[0]);
		expect(out[1].key).toBe("two");
	});
});
