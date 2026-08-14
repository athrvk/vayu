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
 * The data-file store remembers *where* a file is, and must never remember what
 * is in it (issue #599).
 *
 * The rows of a data file are user data of unknown sensitivity - credentials,
 * customer records - and Vayu persists them nowhere: not engine-side, not in a
 * run snapshot, and not here. That rule is stated in three files' comments and
 * was, until this suite, asserted in none. So the persisted payload itself is
 * read back and checked, rather than the store's public surface: a future field
 * that carried rows would pass every behavioural test and fail this one.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useDataFileStore } from "./data-file-store";
import { STORAGE_KEYS } from "@/constants/storage-keys";

const persisted = () => JSON.parse(localStorage.getItem(STORAGE_KEYS.DATA_FILE_STORE) ?? "{}");

beforeEach(() => {
	localStorage.clear();
	useDataFileStore.setState({ locations: {} });
});

describe("data-file-store", () => {
	it("remembers a path per collection and forgets it on clear", () => {
		const { setDataFile, clearDataFile } = useDataFileStore.getState();

		setDataFile("col_1", { path: "/home/u/users.csv", fileName: "users.csv" });
		setDataFile("col_2", { path: "/home/u/plans.csv", fileName: "plans.csv" });
		expect(useDataFileStore.getState().locations.col_1.path).toBe("/home/u/users.csv");

		clearDataFile("col_1");
		expect(useDataFileStore.getState().locations.col_1).toBeUndefined();
		// The key is gone, not set to undefined - an undefined value survives
		// JSON round-tripping as a key whose path is not a string.
		expect(Object.keys(useDataFileStore.getState().locations)).toEqual(["col_2"]);
	});

	it("persists the path and the file name, and nothing that could be a row", () => {
		useDataFileStore
			.getState()
			.setDataFile("col_1", { path: "/home/u/users.csv", fileName: "users.csv" });

		const payload = persisted();
		expect(payload.state.locations.col_1).toEqual({
			path: "/home/u/users.csv",
			fileName: "users.csv",
		});
		// The whole persisted blob, not just the entry: a row that leaked in
		// under any other key would still be on disk.
		const serialized = localStorage.getItem(STORAGE_KEYS.DATA_FILE_STORE) ?? "";
		expect(serialized).not.toBe("");
		expect(serialized).not.toMatch(/rows|columns|parsed/);
	});

	it("carries entries across a version bump instead of dropping them", async () => {
		localStorage.setItem(
			STORAGE_KEYS.DATA_FILE_STORE,
			JSON.stringify({
				version: 0,
				state: { locations: { col_1: { path: "/p/u.csv", fileName: "u.csv" } } },
			})
		);

		await useDataFileStore.persist.rehydrate();

		expect(useDataFileStore.getState().locations.col_1.fileName).toBe("u.csv");
	});

	it("drops an entry that is not a path/name pair rather than handing it to the reader", async () => {
		// A half-written or hand-edited entry must not become the string this
		// app asks the main process to open.
		localStorage.setItem(
			STORAGE_KEYS.DATA_FILE_STORE,
			JSON.stringify({
				version: 1,
				state: {
					locations: {
						col_1: { path: 42, fileName: "u.csv" },
						col_2: { path: "/p/u.csv" },
						col_3: null,
						col_4: { path: "/p/ok.csv", fileName: "ok.csv" },
					},
				},
			})
		);

		await useDataFileStore.persist.rehydrate();

		expect(Object.keys(useDataFileStore.getState().locations)).toEqual(["col_4"]);
	});
});
