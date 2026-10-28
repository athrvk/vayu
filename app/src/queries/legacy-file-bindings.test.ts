/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The bindings an older Vayu kept in `localStorage` move onto the engine's rows
 * once, and the keys go only once they have (#2765).
 *
 * The rules a user relies on: a binding moves to the collection it named and
 * no other; a binding the engine already holds is never overwritten by an
 * older one; a key is cleared after every write it asked for landed, and kept
 * otherwise, so a launch with the engine unreachable loses nothing.
 *
 * Mutation checks: drop the `collection[field]` guard and the never-overwrite
 * case writes; remove the key before awaiting the writes and the failed-write
 * case loses it; skip the import (`importLegacyFileBindings` returning at once)
 * and the first case fails.
 */

import { describe, expect, it, vi } from "vitest";

import { LEGACY_FILE_BINDING_KEYS } from "@/constants/storage-keys";
import type { Collection } from "@/types";
import { importLegacyFileBindings, type LegacyFileBindingDeps } from "./legacy-file-bindings";

const SPEC_KEY = LEGACY_FILE_BINDING_KEYS.SPEC_FILES;
const DATA_KEY = LEGACY_FILE_BINDING_KEYS.DATA_FILES;
const HASH = "c".repeat(64);

/** A key as the old zustand `persist` store wrote it. */
const persisted = (locations: Record<string, unknown>) =>
	JSON.stringify({ state: { locations }, version: 1 });

function memoryStorage(initial: Record<string, string>) {
	const items = new Map(Object.entries(initial));
	return {
		items,
		getItem: (key: string) => items.get(key) ?? null,
		removeItem: (key: string) => void items.delete(key),
	};
}

function deps(initial: Record<string, string>) {
	const storage = memoryStorage(initial);
	const write = vi.fn(async (update: unknown) => update);
	const log = vi.fn();
	return { storage, write, log } satisfies LegacyFileBindingDeps & Record<string, unknown>;
}

const collection = (id: string, bindings: Partial<Collection> = {}): Collection =>
	({ id, name: id, order: 0, ...bindings }) as Collection;

describe("importLegacyFileBindings", () => {
	it("moves each binding to its collection once, and clears the keys", async () => {
		const io = deps({
			[SPEC_KEY]: persisted({ col_1: { path: "/home/u/pets.yaml", fileName: "pets.yaml" } }),
			[DATA_KEY]: persisted({
				col_2: {
					path: "/home/u/users.csv",
					fileName: "users.csv",
					hash: HASH,
					castNumbers: true,
				},
			}),
		});
		const collections = [collection("col_1"), collection("col_2")];

		await importLegacyFileBindings(collections, io);

		expect(io.write.mock.calls.map(([update]) => update)).toEqual([
			{ id: "col_1", specFile: { path: "/home/u/pets.yaml", fileName: "pets.yaml" } },
			{
				id: "col_2",
				dataFile: {
					path: "/home/u/users.csv",
					fileName: "users.csv",
					hash: HASH,
					castNumbers: true,
				},
			},
		]);
		expect(io.storage.items.size).toBe(0);

		// Once: the keys are gone, so the next launch writes nothing.
		await importLegacyFileBindings(collections, io);
		expect(io.write).toHaveBeenCalledTimes(2);
	});

	it("never overwrites a binding the engine already holds", async () => {
		const io = deps({
			[SPEC_KEY]: persisted({ col_1: { path: "/old/pets.yaml", fileName: "pets.yaml" } }),
			[DATA_KEY]: persisted({ col_1: { path: "/old/users.csv", fileName: "users.csv" } }),
		});

		await importLegacyFileBindings(
			[
				collection("col_1", {
					specFile: { path: "/new/pets.yaml", fileName: "pets.yaml" },
					dataFile: { path: "/new/users.csv", fileName: "users.csv" },
				}),
			],
			io
		);

		expect(io.write).not.toHaveBeenCalled();
		// Nothing left to move, so the keys go.
		expect(io.storage.items.size).toBe(0);
	});

	it("drops an entry for a collection the engine no longer lists, and one that names no file", async () => {
		// A collection deleted before the upgrade is in the trash or gone: the
		// list does not name it, and its binding is not carried.
		const io = deps({
			[SPEC_KEY]: persisted({
				trashed: { path: "/home/u/old.yaml", fileName: "old.yaml" },
				col_1: { path: 42, fileName: "pets.yaml" },
				col_2: { path: "/home/u/ok.yaml", fileName: "ok.yaml", content: "openapi: 3.0.0" },
			}),
		});

		await importLegacyFileBindings([collection("col_1"), collection("col_2")], io);

		// The normalizer a row goes through: only `{path, fileName}` survives.
		expect(io.write.mock.calls).toEqual([
			[{ id: "col_2", specFile: { path: "/home/u/ok.yaml", fileName: "ok.yaml" } }],
		]);
		expect(io.storage.items.has(SPEC_KEY)).toBe(false);
	});

	it("keeps a key whose writes did not all land, and finishes on the next launch", async () => {
		const io = deps({
			[DATA_KEY]: persisted({
				col_1: { path: "/home/u/a.csv", fileName: "a.csv" },
				col_2: { path: "/home/u/b.csv", fileName: "b.csv" },
			}),
		});
		io.write.mockImplementationOnce(async () => {
			throw new Error("engine unreachable");
		});
		const collections = [collection("col_1"), collection("col_2")];

		await importLegacyFileBindings(collections, io);

		expect(io.storage.items.has(DATA_KEY)).toBe(true);
		expect((io.log.mock.calls[0][0] as Error).message).toBe("engine unreachable");

		// The next launch's list carries what landed, so only the rest is written.
		io.write.mockClear();
		await importLegacyFileBindings(
			[
				collection("col_1"),
				collection("col_2", { dataFile: { path: "/home/u/b.csv", fileName: "b.csv" } }),
			],
			io
		);
		expect(io.write.mock.calls).toEqual([
			[{ id: "col_1", dataFile: { path: "/home/u/a.csv", fileName: "a.csv" } }],
		]);
		expect(io.storage.items.has(DATA_KEY)).toBe(false);
	});

	it("drops a key that no Vayu could have written, saying so", async () => {
		const io = deps({ [SPEC_KEY]: "{not json", [DATA_KEY]: JSON.stringify([1, 2]) });

		await importLegacyFileBindings([collection("col_1")], io);

		expect(io.write).not.toHaveBeenCalled();
		expect(io.storage.items.size).toBe(0);
		expect(io.log).toHaveBeenCalledTimes(2);
	});

	it("keeps the keys, and never rejects, when the storage itself refuses", async () => {
		const io = deps({ [SPEC_KEY]: persisted({}) });
		const refusing = {
			...io,
			storage: {
				getItem: () => {
					throw new Error("SecurityError");
				},
				removeItem: io.storage.removeItem,
			},
		};

		await expect(
			importLegacyFileBindings([collection("col_1")], refusing)
		).resolves.toBeUndefined();

		expect(io.storage.items.has(SPEC_KEY)).toBe(true);
		expect(io.log).toHaveBeenCalledTimes(2);
	});
});
