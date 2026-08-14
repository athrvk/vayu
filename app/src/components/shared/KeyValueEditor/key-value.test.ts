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
import { toKeyValueEntries, withTrailingBlank } from "./key-value";
import type { KeyValueItem } from "@/types";

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

	it("drops the ephemeral id and system flag but keeps the file members", () => {
		const entries = toKeyValueEntries([{ ...fileRow, key: "avatar", system: true }]);
		expect(entries[0]).not.toHaveProperty("id");
		expect(entries[0]).not.toHaveProperty("system");
		expect(entries[0]).toMatchObject({ key: "avatar", type: "file", src: "/tmp/a.png" });
	});
});
