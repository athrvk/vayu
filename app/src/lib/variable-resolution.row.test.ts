/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Resolution for the one preview that holds a row (issue #1062).
 *
 * `resolveTemplate` beside it previews *composition*, which never has a row: a
 * payload is composed once and a row is bound per iteration, so both spellings
 * of a data read keep their braces there. A Send-with-row is the other case -
 * the row is already picked - and this is the engine's
 * `resolve_template_with_data`, the shape `pm.variables.replaceIn` reaches for
 * the same reason (issue #890).
 *
 * The cases that matter are the ones where the two disagree: a bare column name
 * an environment variable also defines is the collision the tier order exists
 * for, and it is exactly what the preview used to get wrong.
 */

import { describe, it, expect } from "vitest";

import {
	renderDataValue,
	resolveTemplate,
	resolveTemplateWithRow,
	type DataRowCells,
} from "./variable-resolution";

/** A scope lookup over a plain bag, the shape `useVariableResolver` passes. */
const scopes =
	(bag: Record<string, string>) =>
	(name: string): string | undefined =>
		bag[name];

const row = (cells: Record<string, string>): DataRowCells => new Map(Object.entries(cells));

describe("resolveTemplateWithRow", () => {
	it("answers a bare column from the row, above an environment variable of the same name", () => {
		const lookup = scopes({ username: "from-the-environment" });
		expect(
			resolveTemplateWithRow(
				"https://api.test/u/{{username}}",
				lookup,
				row({ username: "ada" })
			)
		).toBe("https://api.test/u/ada");
		// The composition preview beside it, for contrast: no row, so the token
		// is left for the bind - and without the row it would read the
		// environment, which is the value the send never puts on the wire.
		expect(resolveTemplate("https://api.test/u/{{username}}", lookup)).toBe(
			"https://api.test/u/from-the-environment"
		);
	});

	it("gives the bare spelling and {{data.column}} the same answer - they are one bind", () => {
		const cells = row({ email: "ada@example.test" });
		const lookup = scopes({ email: "from-the-environment" });
		expect(resolveTemplateWithRow("{{email}}|{{data.email}}", lookup, cells)).toBe(
			"ada@example.test|ada@example.test"
		);
	});

	it("falls through to the scopes for a bare name the row does not carry", () => {
		// Not a mistake about a column: an ordinary variable, which is what keeps
		// one request previewing the same way with and without a row picked.
		expect(
			resolveTemplateWithRow("{{region}}/{{id}}", scopes({ region: "eu" }), row({ id: "7" }))
		).toBe("eu/7");
	});

	it("leaves a data. name the row has no column for written as it stands", () => {
		// The token says the value came from the file, so a name no column
		// answers is a mistake about the column and an empty string hides it.
		expect(
			resolveTemplateWithRow("{{data.missing}}", scopes({ missing: "x" }), row({ id: "7" }))
		).toBe("{{data.missing}}");
	});

	it("keeps an unknown bare name's braces, as resolution without a row does", () => {
		expect(resolveTemplateWithRow("{{nowhere}}", scopes({}), row({ id: "7" }))).toBe(
			"{{nowhere}}"
		);
	});

	it("resolves a cell that carries tokens of its own through the same lookup", () => {
		expect(
			resolveTemplateWithRow(
				"{{path}}",
				scopes({ host: "api.test" }),
				row({ path: "https://{{host}}/x" })
			)
		).toBe("https://api.test/x");
	});

	it("lets a column named like a generator answer from the row", () => {
		// The engine's order: the row is read before the generator table, so a
		// dataset column spelled `$guid` is the row's, not a fresh id.
		expect(
			resolveTemplateWithRow("{{$guid}}", scopes({}), row({ $guid: "from-the-row" }))
		).toBe("from-the-row");
	});

	it("lets a column named like the identity namespace answer from the row", () => {
		// `$vu` is reserved against a *variable* answering for it, not against a
		// column: `resolve_template_with_data` reads the row before it reaches
		// the reserved check, and the preview reads it the same way.
		expect(resolveTemplateWithRow("{{$vu}}", scopes({ $vu: "9" }), row({ $vu: "3" }))).toBe(
			"3"
		);
	});

	it("keeps the identity namespace deferred when the row has no such column", () => {
		expect(resolveTemplateWithRow("{{$vu}}", scopes({ $vu: "9" }), row({ id: "7" }))).toBe(
			"{{$vu}}"
		);
	});

	it("leaves a cycle in a cell literal rather than expanding forever", () => {
		// `a` (the row) spells `{{b}}`, `b` (a scope) spells `{{a}}` back: the
		// innermost `a` is already being expanded, so its token stays written and
		// the recursion ends there. A row cell joins the same cycle chain a scope
		// value does, because both go through one substitution core.
		expect(resolveTemplateWithRow("{{a}}", scopes({ b: "{{a}}" }), row({ a: "{{b}}" }))).toBe(
			"{{a}}"
		);
	});
});

describe("renderDataValue", () => {
	it("is byte-exact for a string, which is every CSV and TSV cell", () => {
		expect(renderDataValue("ada@example.test")).toBe("ada@example.test");
		expect(renderDataValue("")).toBe("");
	});

	it("spells a number or a boolean as JSON writes it", () => {
		expect(renderDataValue(7)).toBe("7");
		expect(renderDataValue(1.5)).toBe("1.5");
		expect(renderDataValue(true)).toBe("true");
	});

	it("renders a null cell empty", () => {
		// What the value *reads* as. The binder refuses a null cell outright, so
		// this is never a value the wire sees.
		expect(renderDataValue(null)).toBe("");
		expect(renderDataValue(undefined)).toBe("");
	});

	it("renders an object or an array as compact JSON, so a nested cell can still be dropped into a body", () => {
		expect(renderDataValue({ k: 1 })).toBe('{"k":1}');
		expect(renderDataValue([1, "two"])).toBe('[1,"two"]');
	});
});
