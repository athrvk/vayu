/**
 * @vitest-environment jsdom
 */

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The remembered file against the run's (#2051): the hook reads the hash the
 * app last saw for the run's collection and hands both to `dataFileChanged`.
 *
 * Mutation check: read the location of a different collection id, or drop the
 * `undefined` guard, and the "other collection" and "no collection" cases fail.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDataFileStore } from "@/stores";
import { useDataFileChanged } from "./useDataFileChanged";

const A = "a".repeat(64);
const B = "b".repeat(64);

function remember(collectionId: string, hash: string | undefined) {
	useDataFileStore.getState().setDataFile(collectionId, {
		path: "/data/users.csv",
		fileName: "users.csv",
		...(hash ? { hash } : {}),
	});
}

beforeEach(() => {
	useDataFileStore.setState({ locations: {} });
});

describe("useDataFileChanged", () => {
	it("is true when the collection's remembered hash differs from the run's", () => {
		remember("col_1", B);
		const { result } = renderHook(() => useDataFileChanged("col_1", A));
		expect(result.current).toBe(true);
	});

	it("is false when the hashes match", () => {
		remember("col_1", A);
		const { result } = renderHook(() => useDataFileChanged("col_1", A));
		expect(result.current).toBe(false);
	});

	it("is false for a location remembered before hashes were recorded", () => {
		remember("col_1", undefined);
		const { result } = renderHook(() => useDataFileChanged("col_1", A));
		expect(result.current).toBe(false);
	});

	it("is false when only another collection remembers a different file", () => {
		remember("col_2", B);
		const { result } = renderHook(() => useDataFileChanged("col_1", A));
		expect(result.current).toBe(false);
	});

	it("is false without a collection to ask", () => {
		remember("col_1", B);
		const { result } = renderHook(() => useDataFileChanged(undefined, A));
		expect(result.current).toBe(false);
	});

	it("follows the store when a re-read records a new hash", () => {
		remember("col_1", A);
		const { result } = renderHook(() => useDataFileChanged("col_1", A));
		expect(result.current).toBe(false);

		act(() => useDataFileStore.getState().recordDataFileHash("/data/users.csv", B));
		expect(result.current).toBe(true);
	});
});
