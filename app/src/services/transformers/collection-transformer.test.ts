/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the transformer is *for*: a row from an engine that may predate a column
 * must not reach a reader as `undefined` (issue #599).
 *
 * The declared data contract is the newest such column, and its readers - the
 * Data tab's chip list, the run dialog's diff - iterate `columns` without
 * re-checking it. A schema-less row, or a row whose blob got in some other way,
 * has to arrive here as `{}` rather than as the first thing that throws.
 */

import { describe, it, expect } from "vitest";
import { CollectionTransformer } from "./collection-transformer";
import { hasDataContract } from "@/types";

const row = (extra: Record<string, unknown> = {}) => ({
	id: "col_1",
	name: "Users",
	createdAt: 1700000000000,
	updatedAt: 1700000000000,
	...extra,
});

describe("CollectionTransformer data contract", () => {
	it("defaults a row that predates the column to no contract", () => {
		const collection = CollectionTransformer.toFrontend(row());
		expect(collection.dataSchema).toEqual({});
		expect(hasDataContract(collection.dataSchema)).toBe(false);
	});

	it("carries a declared contract through", () => {
		const collection = CollectionTransformer.toFrontend(
			row({
				dataSchema: {
					columns: ["id", "email"],
					declaredAt: 1700000000000,
					fileName: "users.csv",
				},
			})
		);
		expect(collection.dataSchema).toEqual({
			columns: ["id", "email"],
			declaredAt: 1700000000000,
			fileName: "users.csv",
		});
		expect(hasDataContract(collection.dataSchema)).toBe(true);
	});

	it("normalizes a blob that is not a schema instead of passing it on", () => {
		// Not defensiveness for its own sake: every consumer treats `columns` as
		// a string array, and a cast would hand the tab's `.map` a number.
		const collection = CollectionTransformer.toFrontend(
			row({ dataSchema: { columns: ["id", 7, null, "email"], declaredAt: "yesterday" } })
		);
		expect(collection.dataSchema?.columns).toEqual(["id", "email"]);
		expect(collection.dataSchema?.declaredAt).toBeUndefined();
	});

	it("treats a non-object dataSchema as no contract", () => {
		for (const bad of [null, 42, "columns", ["id"]]) {
			const collection = CollectionTransformer.toFrontend(row({ dataSchema: bad }));
			expect(hasDataContract(collection.dataSchema)).toBe(false);
		}
	});

	it("reads an empty column list as no contract, which is what clearing leaves", () => {
		const collection = CollectionTransformer.toFrontend(row({ dataSchema: { columns: [] } }));
		expect(hasDataContract(collection.dataSchema)).toBe(false);
	});
});
