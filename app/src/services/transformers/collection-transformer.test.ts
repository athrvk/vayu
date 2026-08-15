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
import { hasDataContract, hasSpecBinding } from "@/types";

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

/**
 * The spec binding is the same story one column later (issue #637): every reader
 * keys off `specId` - the tab's `GET /specs/:id`, the mapping counter - and a
 * row that predates the column, or one whose blob got in another way, has to
 * arrive as `{}` rather than as an id a fetch is built from.
 */
describe("CollectionTransformer spec binding", () => {
	it("carries a binding through", () => {
		const collection = CollectionTransformer.toFrontend(
			row({ openapi: { specId: "spec_1", specHash: "abc123", syncedAt: 1700000000000 } })
		);
		expect(collection.openapi).toEqual({
			specId: "spec_1",
			specHash: "abc123",
			syncedAt: 1700000000000,
		});
		expect(hasSpecBinding(collection.openapi)).toBe(true);
	});

	it("reads an unbound collection as {} - which is what the engine stores", () => {
		expect(CollectionTransformer.toFrontend(row({ openapi: {} })).openapi).toEqual({});
		expect(hasSpecBinding(CollectionTransformer.toFrontend(row()).openapi)).toBe(false);
	});

	it("drops fields that are not what the binding claims", () => {
		const collection = CollectionTransformer.toFrontend(
			row({ openapi: { specId: 7, specHash: "abc123", syncedAt: "yesterday" } })
		);
		expect(collection.openapi).toEqual({ specHash: "abc123" });
		// No id, so nothing reads it as bound - a `GET /specs/7` is never built.
		expect(hasSpecBinding(collection.openapi)).toBe(false);
	});

	it("treats a non-object openapi as unbound", () => {
		for (const bad of [null, 42, "spec_1", ["spec_1"]]) {
			const collection = CollectionTransformer.toFrontend(row({ openapi: bad }));
			expect(hasSpecBinding(collection.openapi)).toBe(false);
		}
	});
});
