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
 * Send-with-row reading the declared file (issues #601, #751).
 *
 * The hook's job is "which rows can this request bind", and the answer has to
 * come from the file the *declaring* collection remembers - which is why the
 * store is keyed by `contract.collectionId` here rather than by the request's
 * own parent.
 *
 * The row cap is the other half. A file over `maxScenarioDataRows` is one the
 * picker refuses and one `POST /runs` refuses, so offering its rows here would
 * mean a request that sends fine beside a collection that cannot run at all.
 * The cap arrives as an argument for the same reason the contract does - the
 * config query belongs to the provider, not to a hook the URL bar calls - so
 * what is pinned here is that the hook honours the number it is handed rather
 * than any copy of its own.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

import { useDataFileStore } from "@/stores";
import type { DataContractScope } from "@/types";

import { useSendWithRow } from "./useSendWithRow";

/** A cap no case is testing, so the read turns on the file alone. */
const NO_CAP_IN_PLAY = 1000;

const CONTRACT: DataContractScope = {
	collectionName: "Checkout flow",
	collectionId: "col_1",
	columns: ["user"],
};

/** The bridge answering with a CSV of `count` rows, as Electron hands it over. */
function stubBridge(count: number, fileName = "users.csv") {
	const text = `user\n${Array.from({ length: count }, (_, i) => `user-${i}`).join("\n")}`;
	const read = vi.fn(() => Promise.resolve({ bytes: new TextEncoder().encode(text), fileName }));
	vi.stubGlobal("electronAPI", { readDataFile: read });
	return read;
}

beforeEach(() => {
	vi.unstubAllGlobals();
	useDataFileStore.setState({
		locations: { col_1: { path: "/home/u/users.csv", fileName: "users.csv" } },
	});
});

describe("loading the declared file", () => {
	it("reads the file the declaring collection remembers", async () => {
		const read = stubBridge(2);

		const { result } = renderHook(() => useSendWithRow(CONTRACT, NO_CAP_IN_PLAY));
		expect(result.current.available).toBe(true);
		act(() => result.current.load());

		await waitFor(() => expect(result.current.status).toBe("ready"));
		expect(read).toHaveBeenCalledWith("/home/u/users.csv");
		expect(result.current.parsed?.rows).toHaveLength(2);
		expect(result.current.error).toBeNull();
	});

	it("touches the filesystem only when the picker asks", () => {
		const read = stubBridge(2);

		renderHook(() => useSendWithRow(CONTRACT, NO_CAP_IN_PLAY));

		// Mounting a request tab must not open a file for a Send nobody asked for.
		expect(read).not.toHaveBeenCalled();
	});
});

describe("the row cap", () => {
	it("refuses a file over it, naming the setting, with no rows to bind", async () => {
		stubBridge(3);

		const { result } = renderHook(() => useSendWithRow(CONTRACT, 2));
		act(() => result.current.load());

		await waitFor(() => expect(result.current.status).toBe("unavailable"));
		expect(result.current.error).toMatch(/3 rows, over the 2[\s\S]*maxScenarioDataRows/);
		expect(result.current.parsed).toBeNull();
	});

	it("reads the cap it is handed, so raising it offers the same file's rows", async () => {
		stubBridge(3);

		const { result } = renderHook(() => useSendWithRow(CONTRACT, 3));
		act(() => result.current.load());

		await waitFor(() => expect(result.current.status).toBe("ready"));
		expect(result.current.parsed?.rows).toHaveLength(3);
	});
});
