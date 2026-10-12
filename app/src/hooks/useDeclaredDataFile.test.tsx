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
 * The pre-fill is a read, and a pick is the user's answer (issue #2050).
 *
 * A pick in a run dialog declares, and a declare that lands writes the store -
 * which is the very value the pre-fill effect reads. So the case pinned here is
 * the one where the store changes *because of* the pick: the hook must not take
 * that as a remembered file to re-read over the file the user just chose.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDataFileStore } from "@/stores";
import { parseDataFile } from "@/services/data-files";
import type { SelectedDataFile } from "@/modules/collections/DataFilePicker";
import type { Collection } from "@/types";

const collections: Collection[] = [];

vi.mock("@/queries", () => ({
	// A copy, so a case that edits `collections` and rerenders reads a new
	// answer, the way a cache write hands TanStack's subscribers a new array.
	useCollectionsQuery: () => ({ data: [...collections] }),
	// Read by `useDataFileLimits`; no entries leaves the seeded caps standing.
	useConfigQuery: () => ({ data: { entries: [] } }),
}));

const { useDeclaredDataFile } = await import("./useDeclaredDataFile");

function collection(id: string, columns?: string[]): Collection {
	return {
		id,
		name: id,
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		elements: [],
		dataSchema: columns ? { columns } : {},
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	} as Collection;
}

function picked(fileName: string, text: string, path?: string): SelectedDataFile {
	return { fileName, parsed: parseDataFile(text, fileName), path };
}

/** The `readDataFile` bridge, answering every path with `text` as `fileName`. */
function stubReadDataFile(text: string, fileName: string) {
	const read = vi.fn(() => Promise.resolve({ bytes: new TextEncoder().encode(text), fileName }));
	vi.stubGlobal("electronAPI", { readDataFile: read });
	return read;
}

beforeEach(() => {
	collections.length = 0;
	useDataFileStore.setState({ locations: {} });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("useDeclaredDataFile", () => {
	it("returns the collection that declares the contract, not the one it was asked about", () => {
		collections.push(collection("col_p", ["id"]), {
			...collection("col_1"),
			parentId: "col_p",
		});

		const { result } = renderHook(() => useDeclaredDataFile("col_1"));

		expect(result.current.declaringCollectionId).toBe("col_p");
	});

	it("falls back to the caller's collection when nothing declares, and to empty with none", () => {
		collections.push(collection("col_1"));

		expect(
			renderHook(() => useDeclaredDataFile("col_1")).result.current.declaringCollectionId
		).toBe("col_1");
		expect(
			renderHook(() => useDeclaredDataFile(undefined)).result.current.declaringCollectionId
		).toBe("");
	});

	it("keeps declaring for the ancestor after a Remove clears its contract", () => {
		collections.push(collection("col_p", ["id"]), {
			...collection("col_1"),
			parentId: "col_p",
		});
		const { result, rerender } = renderHook(() => useDeclaredDataFile("col_1"));
		expect(result.current.declaringCollectionId).toBe("col_p");

		// What the clear's cache write leaves behind: the ancestor, declaring nothing.
		collections[0] = collection("col_p");
		rerender();

		// Remove then pick is the only way to swap a file, so the pick after a
		// Remove must land where the cleared contract was. Mutation check: drop
		// the held id and this reads col_1.
		expect(result.current.contract).toBeUndefined();
		expect(result.current.declaringCollectionId).toBe("col_p");
	});

	it("keeps declaring on the sub-collection after Remove exposes an ancestor's contract", () => {
		collections.push(collection("col_p", ["id"]), {
			...collection("col_1", ["plan"]),
			parentId: "col_p",
		});
		const { result, rerender } = renderHook(() => useDeclaredDataFile("col_1"));
		expect(result.current.declaringCollectionId).toBe("col_1");

		// What the clear's cache write leaves behind: col_1 declares nothing, so
		// the walk now resolves the ancestor's contract.
		collections[1] = { ...collection("col_1"), parentId: "col_p" };
		rerender();

		// The pick after a Remove must replace col_1's contract, not the ancestor's.
		// Mutation check: follow the live contract again and this reads col_p.
		expect(result.current.contract?.collectionId).toBe("col_p");
		expect(result.current.declaringCollectionId).toBe("col_1");
	});

	it("holds the declarer that resolves once the query answers after mount", () => {
		const snapshot = collection("col_1");
		const { result, rerender } = renderHook(() =>
			useDeclaredDataFile("col_1", { collection: snapshot })
		);
		// Nothing resolved yet: the caller's own collection stands in.
		expect(result.current.declaringCollectionId).toBe("col_1");

		collections.push(collection("col_p", ["id"]), { ...snapshot, parentId: "col_p" });
		rerender();

		expect(result.current.declaringCollectionId).toBe("col_p");
	});

	it("reads the contract off the query once it has the caller's row", () => {
		// The caller's row is a snapshot from when the dialog opened, before the
		// pick that declared.
		const snapshot = collection("col_1");
		const { result, rerender } = renderHook(() =>
			useDeclaredDataFile("col_1", { collection: snapshot })
		);
		expect(result.current.contract).toBeUndefined();

		collections.push(collection("col_1", ["plan", "price"]));
		rerender();

		// Mutation check: put the snapshot ahead of the query's row again and the
		// declare that just landed is invisible here.
		expect(result.current.contract?.columns).toEqual(["plan", "price"]);
	});

	it("resolves the caller's row before the query has it", () => {
		const { result } = renderHook(() =>
			useDeclaredDataFile("col_1", { collection: collection("col_1", ["id"]) })
		);

		expect(result.current.contract?.columns).toEqual(["id"]);
	});

	it("does not re-read over a pick when the pick's declare writes the store", async () => {
		const read = stubReadDataFile("id\n1", "users.csv");
		collections.push(collection("col_1"));
		const { result } = renderHook(() => useDeclaredDataFile("col_1"));

		const plans = picked("plans.csv", "plan,price\nfree,0", "/home/u/plans.csv");
		act(() => result.current.setFile(plans));
		// What a run dialog's declare does once the mutation lands.
		act(() =>
			useDataFileStore
				.getState()
				.setDataFile("col_1", { path: "/home/u/plans.csv", fileName: "plans.csv" })
		);
		await act(async () => {});

		// Mutation check: drop the `picked` gate from the pre-fill effect and the
		// store write reads plans.csv back from disk over the pick.
		expect(read).not.toHaveBeenCalled();
		expect(result.current.file).toBe(plans);
	});

	it("lets a pick made while the pre-fill is in flight win over the read", async () => {
		useDataFileStore.setState({
			locations: { col_1: { path: "/home/u/users.csv", fileName: "users.csv" } },
		});
		let release: (value: { bytes: Uint8Array; fileName: string }) => void = () => {};
		vi.stubGlobal("electronAPI", {
			readDataFile: () =>
				new Promise<{ bytes: Uint8Array; fileName: string }>((resolve) => {
					release = resolve;
				}),
		});
		collections.push(collection("col_1", ["id"]));
		const onPrefill = vi.fn();
		const { result } = renderHook(() => useDeclaredDataFile("col_1", { onPrefill }));

		const plans = picked("plans.csv", "plan\nfree", "/home/u/plans.csv");
		act(() => result.current.setFile(plans));
		await act(async () =>
			release({ bytes: new TextEncoder().encode("id\n1"), fileName: "users.csv" })
		);

		// Mutation check: drop the `picked` check from the read's `.then` and the
		// remembered file replaces the pick, and the dialog is told it pre-filled.
		expect(result.current.file).toBe(plans);
		expect(onPrefill).not.toHaveBeenCalled();
	});

	it("says nothing about a remembered file that fails to read after a pick replaced it", async () => {
		useDataFileStore.setState({
			locations: { col_1: { path: "/home/u/gone.csv", fileName: "gone.csv" } },
		});
		let fail: (reason: Error) => void = () => {};
		vi.stubGlobal("electronAPI", {
			readDataFile: () =>
				new Promise((_, reject) => {
					fail = reject;
				}),
		});
		collections.push(collection("col_1", ["id"]));
		const { result } = renderHook(() => useDeclaredDataFile("col_1"));

		act(() => result.current.setFile(picked("plans.csv", "plan\nfree")));
		await act(async () => fail(new Error("ENOENT: no such file")));

		// Mutation check: drop the `picked` check from the read's `.catch` and
		// a note about the file the user already replaced appears.
		expect(result.current.note).toBeNull();
	});

	it("still pre-fills the remembered file when nothing was picked", async () => {
		useDataFileStore.setState({
			locations: { col_1: { path: "/home/u/users.csv", fileName: "users.csv" } },
		});
		const read = stubReadDataFile("id\n1", "users.csv");
		collections.push(collection("col_1", ["id"]));

		const { result } = renderHook(() => useDeclaredDataFile("col_1"));

		await waitFor(() => expect(result.current.file?.fileName).toBe("users.csv"));
		expect(read).toHaveBeenCalledWith("/home/u/users.csv");
	});
});
