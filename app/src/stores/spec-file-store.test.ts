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
 * The spec-file store remembers *where* a document is, and must never remember
 * what is in it (issue #638).
 *
 * A spec's content is engine state - one row in `spec_documents`, hashed there,
 * bound by id - and a second copy sitting in localStorage would be a copy that
 * cannot be hashed, cannot be re-fetched and cannot be told apart from the
 * bound one. So the persisted payload itself is read back and checked against
 * that rule, the way `data-file-store.test.ts` checks the rows rule: a future
 * field that carried content would pass every behavioural test and fail this.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useSpecFileStore } from "./spec-file-store";
import { STORAGE_KEYS } from "@/constants/storage-keys";

const persisted = () => JSON.parse(localStorage.getItem(STORAGE_KEYS.SPEC_FILE_STORE) ?? "{}");

beforeEach(() => {
	localStorage.clear();
	useSpecFileStore.setState({ locations: {} });
});

describe("spec-file-store", () => {
	it("remembers a path per collection and forgets it on clear", () => {
		const { setSpecFile, clearSpecFile } = useSpecFileStore.getState();

		setSpecFile("col_1", { path: "/home/u/petstore.yaml", fileName: "petstore.yaml" });
		setSpecFile("col_2", { path: "/home/u/billing.json", fileName: "billing.json" });
		expect(useSpecFileStore.getState().locations.col_1.path).toBe("/home/u/petstore.yaml");

		clearSpecFile("col_1");
		expect(useSpecFileStore.getState().locations.col_1).toBeUndefined();
		// The key is gone, not set to undefined - an undefined value survives
		// JSON round-tripping as a key whose path is not a string.
		expect(Object.keys(useSpecFileStore.getState().locations)).toEqual(["col_2"]);
	});

	it("persists the path and the file name, and no spec content", () => {
		useSpecFileStore
			.getState()
			.setSpecFile("col_1", { path: "/home/u/petstore.yaml", fileName: "petstore.yaml" });

		expect(persisted().state.locations.col_1).toEqual({
			path: "/home/u/petstore.yaml",
			fileName: "petstore.yaml",
		});
		// The whole persisted blob, not just the entry: a document that leaked in
		// under any other key would still be on disk.
		const serialized = localStorage.getItem(STORAGE_KEYS.SPEC_FILE_STORE) ?? "";
		expect(serialized).not.toBe("");
		expect(serialized).not.toMatch(/openapi|swagger|paths|content/i);
	});

	it("carries entries across a version bump instead of dropping them", async () => {
		localStorage.setItem(
			STORAGE_KEYS.SPEC_FILE_STORE,
			JSON.stringify({
				version: 0,
				state: { locations: { col_1: { path: "/p/api.yaml", fileName: "api.yaml" } } },
			})
		);

		await useSpecFileStore.persist.rehydrate();

		expect(useSpecFileStore.getState().locations.col_1.fileName).toBe("api.yaml");
	});

	it("drops an entry that is not a path/name pair rather than handing it to the reader", async () => {
		localStorage.setItem(
			STORAGE_KEYS.SPEC_FILE_STORE,
			JSON.stringify({
				version: 1,
				state: {
					locations: {
						col_1: { path: 42, fileName: "api.yaml" },
						col_2: { path: "/p/api.yaml" },
						col_3: null,
						col_4: { path: "/p/ok.yaml", fileName: "ok.yaml" },
					},
				},
			})
		);

		await useSpecFileStore.persist.rehydrate();

		expect(Object.keys(useSpecFileStore.getState().locations)).toEqual(["col_4"]);
	});
});
