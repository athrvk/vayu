/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `toHeaderRows` is the Headers table as the engine takes it (issue #2466):
 * every enabled row, in order, a repeated name repeated. `bodyModeHeaders`
 * names the headers whose last row the body mode wrote (issue #1765), so the
 * engine can tell the body's own Content-Type, which a `content-type` opt-out
 * removes, from one the user typed. The cross-language answer for the first is
 * `header-rows.conformance.test.ts`.
 */

import { describe, it, expect } from "vitest";
import type { KeyValueItem } from "@/types";
import { bodyModeHeaders, toHeaderRows } from "./key-value";

const row = (key: string, extra: Partial<KeyValueItem> = {}): KeyValueItem => ({
	id: key,
	key,
	value: "v",
	enabled: true,
	...extra,
});

describe("toHeaderRows", () => {
	it("keeps a repeated name once per row, in order and in the spelling typed", () => {
		// Mutation check: collapse this to a record, last write wins, and the
		// three X-Dup rows become one.
		const rows = [
			row("X-Dup", { value: "one" }),
			row("x-dup", { value: "two" }),
			row("X-Dup", { value: "three" }),
		];
		expect(toHeaderRows(rows)).toEqual([
			{ name: "X-Dup", value: "one" },
			{ name: "x-dup", value: "two" },
			{ name: "X-Dup", value: "three" },
		]);
	});

	it("keeps the table's order rather than an alphabetical one", () => {
		expect(toHeaderRows([row("Zeta"), row("alpha"), row("Beta")]).map((l) => l.name)).toEqual([
			"Zeta",
			"alpha",
			"Beta",
		]);
	});

	it("skips disabled rows and rows with a blank key", () => {
		const rows = [
			row("A", { enabled: false }),
			row("", { value: "orphan" }),
			row("   "),
			row("B", { value: "" }),
		];
		expect(toHeaderRows(rows)).toEqual([{ name: "B", value: "" }]);
	});

	it("trims the spaces and tabs around a name, and only those", () => {
		// Mutation check: emit item.key as typed and the padded names keep their
		// padding, which the engine would read as a different header.
		const rows = [
			row(" X-A ", { value: " keeps its padding " }),
			row("Authorization\t"),
			row(" \tX-B"),
			row("X C"),
		];
		expect(toHeaderRows(rows)).toEqual([
			{ name: "X-A", value: " keeps its padding " },
			{ name: "Authorization", value: "v" },
			{ name: "X-B", value: "v" },
			{ name: "X C", value: "v" },
		]);
	});

	it("skips a key of only spaces and tabs, and leaves other whitespace to the engine", () => {
		expect(toHeaderRows([row("   "), row("\t"), row(" \t "), row("X-Kept")])).toEqual([
			{ name: "X-Kept", value: "v" },
		]);
		// String.prototype.trim would drop these; the engine trims neither and
		// refuses the name (invalid_header_name), so they are sent on.
		expect(toHeaderRows([row("\n"), row("\u00a0")]).map((l) => l.name)).toEqual([
			"\n",
			"\u00a0",
		]);
	});

	it("reads a stored row with no flag as enabled, as the engine does", () => {
		expect(toHeaderRows([{ key: "A", value: "1" }])).toEqual([{ name: "A", value: "1" }]);
	});

	it("is empty for no rows", () => {
		expect(toHeaderRows([])).toEqual([]);
	});
});

describe("bodyModeHeaders", () => {
	it("names a marked row and leaves the field out when there is none", () => {
		expect(bodyModeHeaders([row("Content-Type", { source: "body-mode" }), row("X-A")])).toEqual(
			{ bodyModeHeaders: ["Content-Type"] }
		);
		expect(bodyModeHeaders([row("Content-Type"), row("Accept", { source: "stream" })])).toEqual(
			{}
		);
	});

	it("follows the last enabled row for a name: a typed one that comes after wins", () => {
		// Mutation check: mark by any row rather than the last one and the
		// typed row that comes last here is reported as the body mode's.
		const typedWins = [row("Content-Type", { source: "body-mode" }), row("Content-Type")];
		expect(bodyModeHeaders(typedWins)).toEqual({});
		const disabledTyped = [
			row("Content-Type", { source: "body-mode" }),
			row("Content-Type", { enabled: false }),
		];
		expect(bodyModeHeaders(disabledTyped)).toEqual({ bodyModeHeaders: ["Content-Type"] });
	});

	it("compares names without case, as the engine does", () => {
		const typedLowercase = [
			row("Content-Type", { source: "body-mode" }),
			row("content-type", { value: "text/csv" }),
		];
		expect(bodyModeHeaders(typedLowercase)).toEqual({});
		const bodyModeLast = [
			row("content-type", { value: "text/csv" }),
			row("Content-Type", { source: "body-mode" }),
		];
		// Listed under the spelling the first row used, the engine's map key.
		expect(bodyModeHeaders(bodyModeLast)).toEqual({ bodyModeHeaders: ["content-type"] });
	});

	it("matches a padded name by its trimmed spelling, and lists it trimmed", () => {
		// Mutation check: key the map by the padded name and the typed row stays
		// a different header from the body mode's, so the body mode's is reported.
		const typedPadded = [
			row("Content-Type", { source: "body-mode" }),
			row(" content-type\t", { value: "text/csv" }),
		];
		expect(bodyModeHeaders(typedPadded)).toEqual({});
		const bodyModePadded = [row(" Content-Type ", { source: "body-mode" })];
		expect(bodyModeHeaders(bodyModePadded)).toEqual({ bodyModeHeaders: ["Content-Type"] });
		expect(bodyModeHeaders([row("  ", { source: "body-mode" })])).toEqual({});
	});
});
