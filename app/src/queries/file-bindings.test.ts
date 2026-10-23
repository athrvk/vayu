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
 * The spec-file and data-file stores are a mirror of the collections list, not
 * a record (#2765): the engine row is what a backup carries, so the stores must
 * follow the list's cache - including a row that leaves it (a delete) and one
 * that comes back (a restore) - and hold nothing the row does not.
 *
 * Mutation checks: install the mirror without its cache subscription and the
 * "follows every write" case fails; mirror inside an effect on the query's data
 * instead of the cache listener and the "same tick" assertion fails; let
 * `mirrorOf` return a new map every time and the "unchanged" case fails; drop
 * the `location.hash === hash` skip in `recordDataFileHash` and a re-read of an
 * unchanged file writes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import { useDataFileStore } from "@/stores/data-file-store";
import { useSpecFileStore } from "@/stores/spec-file-store";
import type { Collection, DataFileLocation, SpecFileLocation } from "@/types";
import { installFileBindingMirror, recordDataFileHash, writeFileBinding } from "./file-bindings";
import { queryKeys } from "./keys";

const updateCollection = vi.fn();
vi.mock("@/services/api", () => ({
	apiService: { updateCollection: (...args: unknown[]) => updateCollection(...args) },
}));

const logError = vi.fn();
vi.mock("@/errors/error-logger", () => ({
	logError: (...args: unknown[]) => logError(...args),
}));

const SPEC: SpecFileLocation = { path: "/home/u/pets.yaml", fileName: "pets.yaml" };
const USERS: DataFileLocation = {
	path: "/home/u/users.csv",
	fileName: "users.csv",
	hash: "a".repeat(64),
};

function collection(
	id: string,
	bindings: { specFile?: SpecFileLocation; dataFile?: DataFileLocation } = {}
): Collection {
	return {
		id,
		name: id,
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		elements: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...bindings,
	};
}

let client: QueryClient;
let uninstall: () => void = () => {};

beforeEach(() => {
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	useSpecFileStore.setState({ locations: {} });
	useDataFileStore.setState({ locations: {} });
	updateCollection.mockReset();
	logError.mockReset();
});

afterEach(() => uninstall());

const setList = (rows: Collection[]) =>
	client.setQueryData<Collection[]>(queryKeys.collections.list(), rows);

describe("installFileBindingMirror", () => {
	it("hydrates from a list that is already cached", () => {
		setList([collection("col_1", { specFile: SPEC, dataFile: USERS }), collection("col_2")]);

		uninstall = installFileBindingMirror(client);

		expect(useSpecFileStore.getState().locations).toEqual({ col_1: SPEC });
		expect(useDataFileStore.getState().locations).toEqual({ col_1: USERS });
	});

	it("follows every write to the list in the same tick, a delete and a restore included", () => {
		uninstall = installFileBindingMirror(client);

		setList([collection("col_1", { dataFile: USERS })]);
		// No await between the write and the read: a reader rendering off the
		// list must find the binding beside it.
		expect(useDataFileStore.getState().locations).toEqual({ col_1: USERS });

		// A delete filters the row out of the list; its binding stays on the
		// engine row, so nothing is written - the entry just leaves the view.
		setList([]);
		expect(useDataFileStore.getState().locations).toEqual({});

		// A restore refetches the row with its binding, and the entry is back.
		setList([collection("col_1", { dataFile: USERS })]);
		expect(useDataFileStore.getState().locations).toEqual({ col_1: USERS });
		expect(updateCollection).not.toHaveBeenCalled();
	});

	it("keeps the same map, and the same entries, when a refetch answers the same bindings", () => {
		uninstall = installFileBindingMirror(client);
		setList([
			collection("col_1", { dataFile: USERS }),
			collection("col_2", { specFile: SPEC }),
		]);
		const dataFiles = useDataFileStore.getState().locations;
		const specFiles = useSpecFileStore.getState().locations;

		// A new array of new objects with the same contents, as a refetch answers.
		setList([
			collection("col_1", { dataFile: { ...USERS } }),
			collection("col_2", { specFile: { ...SPEC } }),
		]);

		expect(useDataFileStore.getState().locations).toBe(dataFiles);
		expect(useSpecFileStore.getState().locations).toBe(specFiles);

		// One entry changes: a new map, the untouched entry carried over as it was.
		setList([
			collection("col_1", { dataFile: { ...USERS, castNumbers: true } }),
			collection("col_2", { specFile: { ...SPEC } }),
		]);
		expect(useDataFileStore.getState().locations).not.toBe(dataFiles);
		expect(useSpecFileStore.getState().locations).toBe(specFiles);
	});

	it("stops following once uninstalled", () => {
		installFileBindingMirror(client)();

		setList([collection("col_1", { dataFile: USERS })]);

		expect(useDataFileStore.getState().locations).toEqual({});
	});
});

describe("writeFileBinding", () => {
	it("puts the answered row in the list, which is what reaches the store", async () => {
		uninstall = installFileBindingMirror(client);
		setList([collection("col_1")]);
		updateCollection.mockResolvedValue(collection("col_1", { specFile: SPEC }));

		await writeFileBinding(client, { id: "col_1", specFile: SPEC });

		expect(updateCollection).toHaveBeenCalledWith({ id: "col_1", specFile: SPEC });
		expect(useSpecFileStore.getState().locations).toEqual({ col_1: SPEC });
	});
});

describe("recordDataFileHash (#2051)", () => {
	const NEW = "d".repeat(64);

	beforeEach(() => {
		updateCollection.mockImplementation(async (update) => update);
	});

	it("writes the new hash to every binding at that path, and only there", () => {
		useDataFileStore.setState({
			locations: {
				col_1: USERS,
				col_2: { path: USERS.path, fileName: "users.csv", castNumbers: true },
				col_3: { path: "/home/u/plans.csv", fileName: "plans.csv" },
			},
		});

		recordDataFileHash(USERS.path, NEW, client);

		expect(updateCollection.mock.calls.map(([update]) => update)).toEqual([
			{ id: "col_1", dataFile: { ...USERS, hash: NEW } },
			// How the file is read rides along: the binding is replaced whole.
			{
				id: "col_2",
				dataFile: { path: USERS.path, fileName: "users.csv", castNumbers: true, hash: NEW },
			},
		]);
	});

	it("writes nothing for an unchanged hash, another path, or a value that is not a digest", () => {
		useDataFileStore.setState({ locations: { col_1: USERS } });

		recordDataFileHash(USERS.path, USERS.hash!, client);
		recordDataFileHash("/home/u/elsewhere.csv", NEW, client);
		recordDataFileHash(USERS.path, "users.csv", client);

		expect(updateCollection).not.toHaveBeenCalled();
	});

	it("logs a refused write rather than throwing into the read it rode on", async () => {
		useDataFileStore.setState({ locations: { col_1: USERS } });
		updateCollection.mockRejectedValue(new Error("engine unreachable"));

		expect(() => recordDataFileHash(USERS.path, NEW, client)).not.toThrow();

		await vi.waitFor(() => expect(logError).toHaveBeenCalledTimes(1));
		expect((logError.mock.calls[0][0] as Error).message).toBe("engine unreachable");
	});
});
