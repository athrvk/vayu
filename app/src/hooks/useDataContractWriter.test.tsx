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
 * The shared contract writer (issue #2050). The Data tab's suite pins the
 * gestures; this pins the writer's own rules, which every caller inherits: the
 * file binding rides the same update as the columns (#2765), a pick with no
 * path forgets the old one, and a caller in no collection writes nothing at
 * all. The binding is asserted on the payload, since the engine row is the
 * record: it carries where the file is and never a row of it.
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useDataFileStore } from "@/stores";
import { parseDataFile } from "@/services/data-files";
import type { SelectedDataFile } from "@/modules/collections/DataFilePicker";

const mutation = {
	mutate: vi.fn(),
	isPending: false,
	isError: false,
	error: null as Error | null,
};

const reading = {
	mutate: vi.fn(),
	isPending: false,
	isError: false,
	error: null as Error | null,
};

vi.mock("@/queries/collections", () => ({
	useUpdateCollectionMutation: () => mutation,
	useDataFileReadingMutation: () => reading,
}));

const { useDataContractWriter } = await import("./useDataContractWriter");

const HASH = "c".repeat(64);

function file(path?: string, castNumbers = false): SelectedDataFile {
	return {
		fileName: "plans.csv",
		parsed: parseDataFile("plan,price\nfree,0", "plans.csv", { castNumbers }),
		text: "plan,price\nfree,0",
		hash: HASH,
		path,
	};
}

beforeEach(() => {
	mutation.mutate.mockClear();
	reading.mutate.mockClear();
	useDataFileStore.setState({
		locations: { col_1: { path: "/home/u/users.csv", fileName: "users.csv" } },
	});
});

describe("useDataContractWriter", () => {
	it("declares the file's columns and binds the file in the same update", () => {
		const { result } = renderHook(() => useDataContractWriter("col_1"));

		result.current.declare(file("/home/u/plans.csv"));

		// Mutation check: drop `hash` from `fileBinding` and MCP's
		// `list_collections` names the file's path with no content digest (#2051).
		expect(mutation.mutate.mock.calls[0][0]).toEqual({
			id: "col_1",
			dataSchema: {
				columns: ["plan", "price"],
				fileName: "plans.csv",
				declaredAt: expect.any(Number),
			},
			dataFile: {
				path: "/home/u/plans.csv",
				fileName: "plans.csv",
				hash: HASH,
				castNumbers: false,
			},
		});
		// The whole payload, not just the binding: a row that leaked in under
		// any key would be stored on the engine row and ride every backup.
		expect(JSON.stringify(mutation.mutate.mock.calls[0][0])).not.toMatch(/rows|parsed|free/);
	});

	it("binds how the declared file was read (#2540)", () => {
		const { result } = renderHook(() => useDataContractWriter("col_1"));

		result.current.declare(file("/home/u/plans.csv", true));

		expect(mutation.mutate.mock.calls[0][0].dataFile.castNumbers).toBe(true);
	});

	it("changes how the bound file is read with a write of its own, never the contract", () => {
		const { result } = renderHook(() => useDataContractWriter("col_1"));

		act(() => result.current.rememberReading(file("/home/u/users.csv", true)));
		// The reading, not a binding: the binding is built when the write is
		// sent (`rememberDataFileReading`), and no contract is written, since
		// the columns do not change with how a value is read.
		expect(reading.mutate.mock.calls).toEqual([
			[{ id: "col_1", path: "/home/u/users.csv", castNumbers: true }],
		]);
		expect(mutation.mutate).not.toHaveBeenCalled();

		// A file the binding does not name, one with no path, or a reading the
		// binding already has, asks for nothing. Mutation check: drop the path
		// guard and the plans.csv toggle becomes a pending write.
		reading.mutate.mockClear();
		act(() => result.current.rememberReading(file("/home/u/plans.csv", true)));
		act(() => result.current.rememberReading(file(undefined, true)));
		act(() => result.current.rememberReading(file("/home/u/users.csv", false)));
		expect(reading.mutate).not.toHaveBeenCalled();
	});

	it("forgets the bound file when the declared file carries no path", () => {
		const { result } = renderHook(() => useDataContractWriter("col_1"));

		result.current.declare(file());

		// Mutation check: send `undefined` (absent, "keep") instead of `null`
		// and users.csv stays bound beside a contract read from another file.
		expect(mutation.mutate.mock.calls[0][0].dataFile).toBeNull();
	});

	it("clears the contract and the binding with explicit nulls", () => {
		const { result } = renderHook(() => useDataContractWriter("col_1"));

		result.current.clear();

		expect(mutation.mutate.mock.calls[0][0]).toEqual({
			id: "col_1",
			dataSchema: null,
			dataFile: null,
		});
	});

	it.each([undefined, null, ""])("writes nothing for a collection id of %j", (id) => {
		const { result } = renderHook(() => useDataContractWriter(id));

		result.current.declare(file("/home/u/plans.csv"));
		result.current.clear();
		act(() => result.current.rememberReading(file("/home/u/users.csv", true)));

		// Mutation check: drop any empty-id guard and an update for an id the
		// engine has no row for goes out.
		expect(mutation.mutate).not.toHaveBeenCalled();
		expect(reading.mutate).not.toHaveBeenCalled();
	});

	it("passes the mutation's state through for SaveFailed", () => {
		mutation.isError = true;
		mutation.error = new Error("engine unreachable");
		const { result } = renderHook(() => useDataContractWriter("col_1"));
		mutation.isError = false;
		mutation.error = null;

		expect(result.current.isError).toBe(true);
		expect(result.current.error?.message).toBe("engine unreachable");
	});

	it("passes a failed reading write through the same way", () => {
		reading.isError = true;
		reading.error = new Error("engine unreachable");
		const { result } = renderHook(() => useDataContractWriter("col_1"));
		reading.isError = false;
		reading.error = null;

		// Mutation check: answer the contract mutation's state alone and a
		// refused toggle reads as saved.
		expect(result.current.isError).toBe(true);
		expect(result.current.error?.message).toBe("engine unreachable");
	});
});
