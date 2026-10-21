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

	it("persists the hash of the file's bytes beside its path (#2051)", () => {
		const hash = "b".repeat(64);
		useDataFileStore
			.getState()
			.setDataFile("col_1", { path: "/home/u/users.csv", fileName: "users.csv", hash });

		expect(persisted().state.locations.col_1).toEqual({
			path: "/home/u/users.csv",
			fileName: "users.csv",
			hash,
		});
	});

	it("keeps a well-formed hash across a rehydrate and drops a malformed one, not its location", async () => {
		const hash = "c".repeat(64);
		localStorage.setItem(
			STORAGE_KEYS.DATA_FILE_STORE,
			JSON.stringify({
				version: 1,
				state: {
					locations: {
						col_1: { path: "/p/a.csv", fileName: "a.csv", hash },
						col_2: { path: "/p/b.csv", fileName: "b.csv", hash: "not-a-digest" },
					},
				},
			})
		);

		await useDataFileStore.persist.rehydrate();

		const { locations } = useDataFileStore.getState();
		expect(locations.col_1).toEqual({ path: "/p/a.csv", fileName: "a.csv", hash });
		expect(locations.col_2).toEqual({ path: "/p/b.csv", fileName: "b.csv" });
	});

	it("records a re-read's hash on every location at that path, and only there", () => {
		const { setDataFile, recordDataFileHash } = useDataFileStore.getState();
		setDataFile("col_1", { path: "/p/users.csv", fileName: "users.csv", hash: "a".repeat(64) });
		setDataFile("col_2", { path: "/p/users.csv", fileName: "users.csv" });
		setDataFile("col_3", { path: "/p/plans.csv", fileName: "plans.csv" });

		recordDataFileHash("/p/users.csv", "d".repeat(64));

		const { locations } = useDataFileStore.getState();
		expect(locations.col_1.hash).toBe("d".repeat(64));
		expect(locations.col_2.hash).toBe("d".repeat(64));
		expect(locations.col_3).not.toHaveProperty("hash");
	});

	it("persists how the file's values are read beside its path (#2540)", () => {
		useDataFileStore.getState().setDataFile("col_1", {
			path: "/home/u/users.csv",
			fileName: "users.csv",
			castNumbers: true,
		});

		expect(persisted().state.locations.col_1).toEqual({
			path: "/home/u/users.csv",
			fileName: "users.csv",
			castNumbers: true,
		});
	});

	it("keeps castNumbers across a rehydrate, reads a legacy entry as off, and drops a non-boolean", async () => {
		localStorage.setItem(
			STORAGE_KEYS.DATA_FILE_STORE,
			JSON.stringify({
				version: 1,
				state: {
					locations: {
						col_1: { path: "/p/a.csv", fileName: "a.csv", castNumbers: true },
						col_2: { path: "/p/b.csv", fileName: "b.csv" },
						col_3: { path: "/p/c.csv", fileName: "c.csv", castNumbers: "yes" },
					},
				},
			})
		);

		await useDataFileStore.persist.rehydrate();

		// Mutation check: drop `castNumbers` from `normalizeDataFiles` and col_1
		// comes back as text on every launch.
		const { locations } = useDataFileStore.getState();
		expect(locations.col_1).toEqual({ path: "/p/a.csv", fileName: "a.csv", castNumbers: true });
		expect(locations.col_2.castNumbers ?? false).toBe(false);
		expect(locations.col_3).toEqual({ path: "/p/c.csv", fileName: "c.csv" });
	});

	it("keeps castNumbers when a re-read records a new hash", () => {
		const { setDataFile, recordDataFileHash } = useDataFileStore.getState();
		setDataFile("col_1", { path: "/p/users.csv", fileName: "users.csv", castNumbers: true });

		recordDataFileHash("/p/users.csv", "d".repeat(64));

		expect(useDataFileStore.getState().locations.col_1).toEqual({
			path: "/p/users.csv",
			fileName: "users.csv",
			hash: "d".repeat(64),
			castNumbers: true,
		});
	});

	it("changes castNumbers only on a binding that still names the file", () => {
		const { setDataFile, setDataFileCastNumbers } = useDataFileStore.getState();
		setDataFile("col_1", { path: "/p/users.csv", fileName: "users.csv", hash: "a".repeat(64) });

		setDataFileCastNumbers("col_1", "/p/users.csv", true);
		expect(useDataFileStore.getState().locations.col_1).toEqual({
			path: "/p/users.csv",
			fileName: "users.csv",
			hash: "a".repeat(64),
			castNumbers: true,
		});

		// Another file's toggle, or a collection with no binding, writes nothing.
		const before = useDataFileStore.getState().locations;
		setDataFileCastNumbers("col_1", "/p/plans.csv", false);
		setDataFileCastNumbers("col_2", "/p/users.csv", true);
		setDataFileCastNumbers("col_1", "/p/users.csv", true);
		expect(useDataFileStore.getState().locations).toBe(before);
	});

	it("leaves the map untouched when the hash has not changed", () => {
		const { setDataFile, recordDataFileHash } = useDataFileStore.getState();
		setDataFile("col_1", { path: "/p/users.csv", fileName: "users.csv", hash: "a".repeat(64) });
		const before = useDataFileStore.getState().locations;

		recordDataFileHash("/p/users.csv", "a".repeat(64));
		recordDataFileHash("/p/elsewhere.csv", "e".repeat(64));
		// Nor is a value that is not a digest written over a good one.
		recordDataFileHash("/p/users.csv", "users.csv");

		// The same object: the mirror republishes on a new one.
		expect(useDataFileStore.getState().locations).toBe(before);
	});
});
