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
 * extractor and the collection-run cases fail. For `classifyDataFile` (#2057),
 * require the run's hash before answering `missing` and the "recorded before
 * hashes" case fails; answer `unknown` for a missing reply and the missing
 * cases fail.
 */

import { describe, it, expect } from "vitest";
import type { RunConfigSnapshot } from "@/types";
import {
	classifyDataFile,
	dataFileChanged,
	dataFileNote,
	DATA_FILE_CHANGED_NOTE,
	DATA_FILE_MISSING_NOTE,
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

describe("classifyDataFile", () => {
	it("is missing when the file is gone, with or without a hash on the run", () => {
		expect(classifyDataFile(A, { status: "missing" })).toBe("missing");
		expect(classifyDataFile(undefined, { status: "missing" })).toBe("missing");
	});

	it("is changed or unchanged by comparing the hashes of a file that is there", () => {
		expect(classifyDataFile(A, { status: "found", hash: B })).toBe("changed");
		expect(classifyDataFile(A, { status: "found", hash: A })).toBe("unchanged");
	});

	it("is unknown when there is no answer about the file", () => {
		expect(classifyDataFile(A, undefined)).toBe("unknown");
		expect(classifyDataFile(undefined, undefined)).toBe("unknown");
	});

	it("is unknown for a file that is there when the run recorded no hash to compare", () => {
		expect(classifyDataFile(undefined, { status: "found", hash: A })).toBe("unknown");
	});
});

describe("dataFileNote", () => {
	it("says something only for a changed or a missing file", () => {
		expect(dataFileNote("changed")).toBe(` ${DATA_FILE_CHANGED_NOTE}`);
		expect(dataFileNote("missing")).toBe(` ${DATA_FILE_MISSING_NOTE}`);
		expect(dataFileNote("unchanged")).toBe("");
		expect(dataFileNote("unknown")).toBe("");
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
