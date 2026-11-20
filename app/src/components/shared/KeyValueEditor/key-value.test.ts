/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What counts as a blank row, which is the rule two different things read: the
 * trailing spare row the table always keeps, and which rows are worth storing.
 *
 * A file part keeps its content in `src`, not in `value` - so a key/value test
 * alone called a row holding a chosen file blank, and Save dropped the upload
 * (issue #393).
 */

import { describe, it, expect } from "vitest";
import {
	carryRowIds,
	sameRows,
	toKeyValueEntries,
	toKeyValueItems,
	withTrailingBlank,
} from "./key-value";
import type { FormFieldEntry, KeyValueItem } from "@/types";

const fileRow: KeyValueItem = {
	id: "r1",
	key: "",
	value: "",
	enabled: true,
	type: "file",
	src: "/tmp/a.png",
	fileName: "a.png",
};

describe("blank rows", () => {
	it("keeps a row that holds only a chosen file", () => {
		expect(toKeyValueEntries([fileRow])).toEqual([
			{
				key: "",
				value: "",
				enabled: true,
				type: "file",
				src: "/tmp/a.png",
				fileName: "a.png",
			},
		]);
	});

	it("adds a spare row after one that holds only a file", () => {
		const rows = withTrailingBlank([fileRow]);
		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatchObject({ key: "", value: "" });
	});

	it("still treats an empty text row as the spare", () => {
		const blank: KeyValueItem = { id: "r2", key: "", value: "", enabled: true };
		expect(withTrailingBlank([blank])).toHaveLength(1);
		expect(toKeyValueEntries([blank])).toEqual([]);
	});

	it("drops the ephemeral id but keeps the file members", () => {
		const entries = toKeyValueEntries([{ ...fileRow, key: "avatar" }]);
		expect(entries[0]).not.toHaveProperty("id");
		expect(entries[0]).toMatchObject({ key: "avatar", type: "file", src: "/tmp/a.png" });
	});
});

/**
 * Row identity across a refetch (#3663). Every conversion from storage makes
 * fresh ids, and a table keyed by id remounts a row whose id changed, so a
 * refetched table must neither read as changed for its ids nor lose the ids
 * of rows it did not change.
 */
describe("row identity across a refetch", () => {
	const row = (id: string, key: string, value: string): KeyValueItem => ({
		id,
		key,
		value,
		enabled: true,
	});

	it("reads two tables as the same when only ids and the spare row differ", () => {
		const draft = [row("a", "X-One", "1"), row("spare", "", "")];
		const refetched = toKeyValueItems([{ key: "X-One", value: "1", enabled: true }]);
		expect(sameRows(draft, refetched)).toBe(true);
	});

	it("reads a row the engine hands back in another member order as the same", () => {
		const draft = [{ id: "a", key: "X-One", value: "1", enabled: true, description: "d" }];
		const stored = JSON.parse(
			'{"description":"d","enabled":true,"key":"X-One","value":"1"}'
		) as FormFieldEntry;
		expect(sameRows(draft, toKeyValueItems([stored]))).toBe(true);
	});

	it("reads a changed name, value, toggle or row count as a change", () => {
		const draft = [row("a", "X-One", "1")];
		expect(sameRows(draft, [row("a", "X-Two", "1")])).toBe(false);
		expect(sameRows(draft, [row("a", "X-One", "2")])).toBe(false);
		expect(sameRows(draft, [{ ...row("a", "X-One", "1"), enabled: false }])).toBe(false);
		expect(sameRows(draft, [row("a", "X-One", "1"), row("b", "X-One", "1")])).toBe(false);
	});

	it("carries ids by content, each once and in order, and gives a changed row a fresh one", () => {
		const current = [
			row("dup-1", "X-Dup", "1"),
			row("dup-2", "X-Dup", "1"),
			row("edited", "X-Old", "1"),
			row("spare", "", ""),
		];
		const incoming = toKeyValueItems([
			{ key: "X-Dup", value: "1", enabled: true },
			{ key: "X-New", value: "1", enabled: true },
			{ key: "X-Dup", value: "1", enabled: true },
		]);

		const carried = carryRowIds(current, incoming);

		expect(carried.map((r) => r.id)).toEqual([
			"dup-1",
			incoming[1].id,
			"dup-2",
			// The spare row keeps the draft's, so a caret left in it stays.
			"spare",
		]);
		expect(carried.map((r) => r.key)).toEqual(["X-Dup", "X-New", "X-Dup", ""]);
	});

	it("never hands a content row the spare row's id", () => {
		const carried = carryRowIds(
			[row("spare", "", "")],
			[row("fresh", "X-One", "1"), row("fresh-spare", "", "")]
		);
		expect(carried.map((r) => r.id)).toEqual(["fresh", "spare"]);
	});
});
