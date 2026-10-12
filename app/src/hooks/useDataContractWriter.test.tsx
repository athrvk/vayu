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
 * remembered path follows a landed write only, a pick with no path forgets the
 * old one, and a caller in no collection writes nothing at all.
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

vi.mock("@/queries/collections", () => ({
	useUpdateCollectionMutation: () => mutation,
}));

const { useDataContractWriter } = await import("./useDataContractWriter");

function file(path?: string): SelectedDataFile {
	return {
		fileName: "plans.csv",
		parsed: parseDataFile("plan,price\nfree,0", "plans.csv"),
		path,
	};
}

/** Resolve the last mutation the way TanStack would, running the caller's onSuccess. */
function succeed() {
	const [, options] = mutation.mutate.mock.calls[mutation.mutate.mock.calls.length - 1];
	act(() => options?.onSuccess?.({}));
}

beforeEach(() => {
	mutation.mutate.mockClear();
	useDataFileStore.setState({
		locations: { col_1: { path: "/home/u/users.csv", fileName: "users.csv" } },
	});
});

describe("useDataContractWriter", () => {
	it("declares the file's columns, and remembers its path once the write lands", () => {
		const { result } = renderHook(() => useDataContractWriter("col_1"));

		result.current.declare(file("/home/u/plans.csv"));

		expect(mutation.mutate.mock.calls[0][0]).toEqual({
			id: "col_1",
			dataSchema: {
				columns: ["plan", "price"],
				fileName: "plans.csv",
				declaredAt: expect.any(Number),
			},
		});
		expect(useDataFileStore.getState().locations.col_1.fileName).toBe("users.csv");
		succeed();
		expect(useDataFileStore.getState().locations.col_1).toEqual({
			path: "/home/u/plans.csv",
			fileName: "plans.csv",
		});
	});

	it("forgets the remembered path when the declared file carries none", () => {
		const { result } = renderHook(() => useDataContractWriter("col_1"));

		result.current.declare(file());
		succeed();

		// Mutation check: drop the `clearDataFile` branch and users.csv stays
		// remembered beside a contract read from another file.
		expect(useDataFileStore.getState().locations.col_1).toBeUndefined();
	});

	it("clears with an explicit null, then forgets the path", () => {
		const { result } = renderHook(() => useDataContractWriter("col_1"));

		result.current.clear();

		expect(mutation.mutate.mock.calls[0][0]).toEqual({ id: "col_1", dataSchema: null });
		succeed();
		expect(useDataFileStore.getState().locations.col_1).toBeUndefined();
	});

	it.each([undefined, null, ""])("writes nothing for a collection id of %j", (id) => {
		const { result } = renderHook(() => useDataContractWriter(id));

		result.current.declare(file("/home/u/plans.csv"));
		result.current.clear();

		// Mutation check: drop either empty-id guard and an update for an id the
		// engine has no row for goes out.
		expect(mutation.mutate).not.toHaveBeenCalled();
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
});
