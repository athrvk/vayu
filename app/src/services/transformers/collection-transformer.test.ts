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

/**
 * The file bindings (#2765): whatever comes out of here reaches the read IPC
 * as a path, so a value that is not a `{path, fileName}` pair of non-empty
 * strings is no binding at all, and an engine that predates the columns (or
 * answers `{}` for "no file") reads as unbound rather than as a half-location.
 *
 * Mutation checks: let `toSpecFileLocation` accept an empty path (one the
 * engine refuses to store) and the "an empty path" case fails; drop the
 * `DATA_FILE_HASH_PATTERN` test and the malformed-hash case keeps a digest no
 * run could have recorded.
 */
describe("CollectionTransformer file bindings", () => {
	const HASH = "c".repeat(64);

	it("carries both bindings through", () => {
		const collection = CollectionTransformer.toFrontend(
			row({
				specFile: { path: "/home/u/pets.yaml", fileName: "pets.yaml" },
				dataFile: {
					path: "/home/u/users.csv",
					fileName: "users.csv",
					hash: HASH,
					castNumbers: true,
				},
			})
		);
		expect(collection.specFile).toEqual({ path: "/home/u/pets.yaml", fileName: "pets.yaml" });
		expect(collection.dataFile).toEqual({
			path: "/home/u/users.csv",
			fileName: "users.csv",
			hash: HASH,
			castNumbers: true,
		});
	});

	it("reads the engine's {} and an older engine's missing column as no binding", () => {
		for (const collection of [
			CollectionTransformer.toFrontend(row({ specFile: {}, dataFile: {} })),
			CollectionTransformer.toFrontend(row()),
		]) {
			expect(collection).not.toHaveProperty("specFile");
			expect(collection).not.toHaveProperty("dataFile");
		}
	});

	it.each([
		["a non-string path", { path: 42, fileName: "u.csv" }],
		["no file name", { path: "/p/u.csv" }],
		["an empty path", { path: "", fileName: "u.csv" }],
		["null", null],
		["a string", "/p/u.csv"],
	])("drops a binding with %s rather than handing it to the reader", (_label, value) => {
		const collection = CollectionTransformer.toFrontend(
			row({ specFile: value, dataFile: value })
		);
		expect(collection).not.toHaveProperty("specFile");
		expect(collection).not.toHaveProperty("dataFile");
	});

	it("drops a malformed hash and a non-boolean castNumbers, not the location", () => {
		const collection = CollectionTransformer.toFrontend(
			row({
				dataFile: {
					path: "/p/b.csv",
					fileName: "b.csv",
					hash: "NOT-A-DIGEST",
					castNumbers: "yes",
				},
			})
		);
		expect(collection.dataFile).toEqual({ path: "/p/b.csv", fileName: "b.csv" });
	});

	it("keeps no member beyond the location's own", () => {
		// A spec file has no hash, and nothing that could be a row or a document
		// rides a binding into the app.
		const collection = CollectionTransformer.toFrontend(
			row({
				specFile: { path: "/p/s.yaml", fileName: "s.yaml", hash: HASH, content: "openapi" },
				dataFile: { path: "/p/u.csv", fileName: "u.csv", rows: [{ id: 1 }] },
			})
		);
		expect(collection.specFile).toEqual({ path: "/p/s.yaml", fileName: "s.yaml" });
		expect(collection.dataFile).toEqual({ path: "/p/u.csv", fileName: "u.csv" });
	});
});
