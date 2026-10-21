/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which file drove a run, read out of the shapes that name it (#2051), how it
 * was read (#2540), and when that file counts as changed.
 *
 * Mutation check: make `dataFileChanged` return `runHash !== rememberedHash`
 * and the "cannot be compared" cases fail; drop the `scenario` read from either
 * extractor and the collection-run cases fail. For `classifyDataFile` (#2057),
 * require the run's hash before answering `missing` and the "recorded before
 * hashes" case fails; answer `unknown` for a missing reply and the missing
 * cases fail. Drop `castNumbers` from `dataFileFromBlock`, or read any truthy
 * value as cast, and the reading cases fail.
 */

import { describe, it, expect } from "vitest";
import type { RunConfigSnapshot } from "@/types";
import {
	classifyDataFile,
	dataFileChanged,
	dataFileDisplayName,
	dataFileNote,
	DATA_FILE_CAST_NOTE,
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
		).toEqual({ fileName: "users.csv", hash: A, castNumbers: false });
	});

	it("reads a load run's pair from the top level", () => {
		expect(dataFileFromSnapshot({ dataFileName: "users.csv", dataFileHash: A })).toEqual({
			fileName: "users.csv",
			hash: A,
			castNumbers: false,
		});
	});

	it("reads how the run read the file, from either shape (#2540)", () => {
		expect(
			dataFileFromSnapshot({
				scenario: { dataFileName: "plans.csv", dataFileHash: A, dataFileCastNumbers: true },
			})
		).toEqual({ fileName: "plans.csv", hash: A, castNumbers: true });
		expect(
			dataFileFromSnapshot({ dataFileName: "plans.csv", dataFileCastNumbers: true })
		).toEqual({ fileName: "plans.csv", castNumbers: true });
	});

	it.each([
		["absent, as every run recorded before the flag", {}],
		["false", { dataFileCastNumbers: false }],
		["a wrong-typed value", { dataFileCastNumbers: "true" }],
	])("reads the file as text when the flag is %s", (_label, extra) => {
		const snapshot = { dataFileName: "plans.csv", ...extra } as RunConfigSnapshot;
		expect(dataFileFromSnapshot(snapshot)?.castNumbers).toBe(false);
	});

	it("keeps a name with no hash, and omits the hash key rather than setting it undefined", () => {
		const file = dataFileFromSnapshot({ dataFileName: "users.csv" });
		expect(file).toEqual({ fileName: "users.csv", castNumbers: false });
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
		expect(
			dataFileFromSummary({ scenario: { dataFileName: "a.csv", dataFileCastNumbers: true } })
		).toEqual({ fileName: "a.csv", castNumbers: true });
		expect(dataFileFromSummary({ dataFileName: "b.csv", dataFileHash: B })).toEqual({
			fileName: "b.csv",
			hash: B,
			castNumbers: false,
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

describe("classifyDataFile (the reading, #2636)", () => {
	const same = { status: "found", hash: A } as const;

	it.each([
		["the run read text and the binding now casts", false, true],
		["the run cast and the binding now reads text", true, false],
		["the run recorded no flag and the binding now casts", undefined, true],
		["the run cast and the binding has no flag", true, undefined],
	])("is readingChanged for the same bytes when %s", (_label, run, binding) => {
		expect(classifyDataFile(A, same, run, binding)).toBe("readingChanged");
	});

	it.each([
		["both cast", true, true],
		["both read text", false, false],
		["an old run with no flag against a binding with none", undefined, undefined],
		["an old run with no flag against a binding that reads text", undefined, false],
	])("is unchanged for the same bytes when %s", (_label, run, binding) => {
		expect(classifyDataFile(A, same, run, binding)).toBe("unchanged");
	});

	it("lets different bytes win over a different reading", () => {
		expect(classifyDataFile(A, { status: "found", hash: B }, false, true)).toBe("changed");
	});

	it("lets a missing file win over a different reading", () => {
		expect(classifyDataFile(A, { status: "missing" }, false, true)).toBe("missing");
	});

	it("stays unknown when there is nothing to compare the reading against", () => {
		expect(classifyDataFile(undefined, same, false, true)).toBe("unknown");
		expect(classifyDataFile(A, undefined, false, true)).toBe("unknown");
	});
});

describe("dataFileNote", () => {
	it("says something only for a changed, a re-read or a missing file", () => {
		expect(dataFileNote("changed")).toBe(` ${DATA_FILE_CHANGED_NOTE}`);
		expect(dataFileNote("readingChanged")).toBe(" (number reading changed since this run)");
		expect(dataFileNote("missing")).toBe(` ${DATA_FILE_MISSING_NOTE}`);
		expect(dataFileNote("unchanged")).toBe("");
		expect(dataFileNote("unknown")).toBe("");
	});
});

describe("dataFileDisplayName", () => {
	it("names the reading only when numbers were cast", () => {
		expect(dataFileDisplayName("plans.csv", true)).toBe(`plans.csv ${DATA_FILE_CAST_NOTE}`);
		expect(dataFileDisplayName("plans.csv", false)).toBe("plans.csv");
		expect(dataFileDisplayName("plans.csv", undefined)).toBe("plans.csv");
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
