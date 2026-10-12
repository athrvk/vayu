/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which file drove a run, read out of the shapes that name it (#2051), and
 * when that file counts as changed.
 *
 * Mutation check: make `dataFileChanged` return `runHash !== rememberedHash`
 * and the "cannot be compared" cases fail; drop the `scenario` read from either
 * extractor and the collection-run cases fail.
 */

import { describe, it, expect } from "vitest";
import type { RunConfigSnapshot } from "@/types";
import {
	dataFileChanged,
	dataFileFromSnapshot,
	dataFileFromSummary,
	runDataFileName,
} from "./run-data-file";

const A = "a".repeat(64);
const B = "b".repeat(64);

describe("dataFileFromSnapshot", () => {
	it("reads a collection run's pair from its scenario block", () => {
		expect(
			dataFileFromSnapshot({
				scenario: { collectionId: "c", dataFileName: "users.csv", dataFileHash: A },
			})
		).toEqual({ fileName: "users.csv", hash: A });
	});

	it("reads a load run's pair from the top level", () => {
		expect(dataFileFromSnapshot({ dataFileName: "users.csv", dataFileHash: A })).toEqual({
			fileName: "users.csv",
			hash: A,
		});
	});

	it("keeps a name with no hash, and omits the hash key rather than setting it undefined", () => {
		const file = dataFileFromSnapshot({ dataFileName: "users.csv" });
		expect(file).toEqual({ fileName: "users.csv" });
		expect(file && "hash" in file).toBe(false);
	});

	it.each([
		["no snapshot", undefined],
		["no file keys", { mode: "constant_rps" }],
		["an empty name", { dataFileName: "" }],
		["a wrong-typed name", { dataFileName: 7 }],
		["a scenario block that is not an object", { scenario: "collection" }],
	])("is null for %s", (_label, snapshot) => {
		// The wire is not validated, so a wrong-typed value is a case worth
		// pinning even though the declared type forbids it.
		expect(dataFileFromSnapshot(snapshot as RunConfigSnapshot | undefined)).toBeNull();
	});
});

describe("dataFileFromSummary", () => {
	it("reads the list row's scenario block and its top level", () => {
		expect(dataFileFromSummary({ scenario: { dataFileName: "a.csv" } })).toEqual({
			fileName: "a.csv",
		});
		expect(dataFileFromSummary({ dataFileName: "b.csv", dataFileHash: B })).toEqual({
			fileName: "b.csv",
			hash: B,
		});
	});

	it("is null for a row without one", () => {
		expect(dataFileFromSummary(undefined)).toBeNull();
		expect(dataFileFromSummary({ scenario: { collectionId: "c" } })).toBeNull();
	});
});

describe("dataFileChanged", () => {
	it("is true only when both hashes are known and differ", () => {
		expect(dataFileChanged(A, B)).toBe(true);
	});

	it("is false when they match", () => {
		expect(dataFileChanged(A, A)).toBe(false);
	});

	it.each([
		["the run's hash", undefined, B],
		["the remembered hash", A, undefined],
		["both hashes", undefined, undefined],
	])("is false when %s is unknown, since nothing can be compared", (_label, run, remembered) => {
		expect(dataFileChanged(run, remembered)).toBe(false);
	});
});

describe("runDataFileName", () => {
	it("passes a plain file name through", () => {
		expect(runDataFileName("users.csv")).toBe("users.csv");
	});

	it("leaves out a name the engine would refuse as a path", () => {
		for (const name of ["odd\\name.csv", "dir/users.csv"]) {
			expect(runDataFileName(name)).toBeUndefined();
		}
	});
});
