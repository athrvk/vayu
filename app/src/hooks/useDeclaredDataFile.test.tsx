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
 * The pre-fill survives the hash its own read records (#2051).
 *
 * `readDeclaredDataFile` records the file's hash against the remembered path,
 * which replaces the location object in `data-file-store` while the read is
 * still pending. The read's effect must depend on the location's identity
 * (path and name), not on the object, or that replacement cancels it and the
 * dialog opens on an empty picker with no note.
 *
 * Mutation check: put `rememberedFile` back in the effect's dependencies and
 * the first case fails (the file never arrives, `onPrefill` never fires).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useDataFileStore } from "@/stores";
import type { Collection } from "@/types";
import { useDeclaredDataFile } from "./useDeclaredDataFile";

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({ data: [] }),
	useConfigQuery: () => ({ data: { entries: [] } }),
}));

const COLLECTION = {
	id: "col_1",
	name: "Checkout",
	parentId: null,
	dataSchema: { columns: ["user"] },
} as unknown as Collection;

const STORED = "a".repeat(64);
const ON_DISK = "b".repeat(64);

function stubRead(hash: string) {
	vi.stubGlobal("electronAPI", {
		readDataFile: async () => ({
			bytes: new TextEncoder().encode("user\nada"),
			fileName: "users.csv",
			hash,
		}),
	});
}

beforeEach(() => {
	vi.unstubAllGlobals();
	useDataFileStore.setState({ locations: {} });
});

describe("useDeclaredDataFile", () => {
	it.each([
		["no stored hash", undefined],
		["a stale stored hash", STORED],
	])("pre-fills the remembered file when the read records a new hash (%s)", async (_, stored) => {
		useDataFileStore.getState().setDataFile("col_1", {
			path: "/data/users.csv",
			fileName: "users.csv",
			...(stored ? { hash: stored } : {}),
		});
		stubRead(ON_DISK);
		const onPrefill = vi.fn();

		const { result } = renderHook(() =>
			useDeclaredDataFile("col_1", { collection: COLLECTION, onPrefill })
		);

		await waitFor(() => expect(result.current.file?.fileName).toBe("users.csv"));
		expect(onPrefill).toHaveBeenCalledTimes(1);
		expect(result.current.note).toBeNull();
		expect(useDataFileStore.getState().locations.col_1?.hash).toBe(ON_DISK);
	});

	it("pre-fills when the stored hash already matches, leaving the location untouched", async () => {
		const location = { path: "/data/users.csv", fileName: "users.csv", hash: ON_DISK };
		useDataFileStore.getState().setDataFile("col_1", location);
		stubRead(ON_DISK);

		const { result } = renderHook(() =>
			useDeclaredDataFile("col_1", { collection: COLLECTION })
		);

		await waitFor(() => expect(result.current.file?.fileName).toBe("users.csv"));
		expect(useDataFileStore.getState().locations.col_1).toBe(location);
	});
});
