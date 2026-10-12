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
 * The remembered file against the run's (#2051). With the hash bridge the hook
 * compares the run's hash with the file's digest as it is now; without one, a
 * browser build, with the hash the app last recorded for the collection.
 *
 * Mutation checks: read the location of a different collection id, or drop the
 * `undefined` guard, and the "other collection" and "no collection" cases fail;
 * compare against the stored hash while bridged and the "edited on disk" cases
 * fail; treat a failed hash as a changed file and the "cannot be hashed" case
 * fails.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
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
	vi.unstubAllGlobals();
	useDataFileStore.setState({ locations: {} });
});

describe("useDataFileChanged without the hash bridge (the stored hash)", () => {
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

describe("useDataFileChanged with the hash bridge (the file as it is now)", () => {
	const stubHash = (impl: (path: string) => Promise<string>) => {
		const hashDataFile = vi.fn(impl);
		vi.stubGlobal("electronAPI", { hashDataFile });
		return hashDataFile;
	};

	it("is true when the file was edited on disk after the run, whatever the store says", async () => {
		remember("col_1", A);
		const hashDataFile = stubHash(async () => B);
		const { result } = renderHook(() => useDataFileChanged("col_1", A));
		await waitFor(() => expect(result.current).toBe(true));
		expect(hashDataFile).toHaveBeenCalledWith("/data/users.csv");
	});

	it("is false when the file on disk still matches the run, even over a stale stored hash", async () => {
		remember("col_1", B);
		const hashDataFile = stubHash(async () => A);
		const { result } = renderHook(() => useDataFileChanged("col_1", A));
		await waitFor(() => expect(hashDataFile).toHaveBeenCalled());
		await act(async () => {});
		expect(result.current).toBe(false);
	});

	it("is false while the hash is in flight", () => {
		remember("col_1", B);
		stubHash(() => new Promise<string>(() => {}));
		const { result } = renderHook(() => useDataFileChanged("col_1", A));
		expect(result.current).toBe(false);
	});

	it("is false for a file that cannot be hashed, rather than reporting it changed", async () => {
		remember("col_1", B);
		const hashDataFile = stubHash(async () => {
			throw new Error("The file is no longer at /data/users.csv - pick it again.");
		});
		const { result } = renderHook(() => useDataFileChanged("col_1", A));
		await waitFor(() => expect(hashDataFile).toHaveBeenCalled());
		await act(async () => {});
		expect(result.current).toBe(false);
	});

	it("asks nothing without a remembered location", () => {
		const hashDataFile = stubHash(async () => B);
		const { result } = renderHook(() => useDataFileChanged("col_1", A));
		expect(result.current).toBe(false);
		expect(hashDataFile).not.toHaveBeenCalled();
	});

	it("hashes again when the window regains focus", async () => {
		remember("col_1", A);
		let onDisk = A;
		const hashDataFile = stubHash(async () => onDisk);
		const { result } = renderHook(() => useDataFileChanged("col_1", A));
		await waitFor(() => expect(hashDataFile).toHaveBeenCalledTimes(1));
		expect(result.current).toBe(false);

		onDisk = B;
		act(() => {
			window.dispatchEvent(new Event("focus"));
		});
		await waitFor(() => expect(result.current).toBe(true));
	});
});
