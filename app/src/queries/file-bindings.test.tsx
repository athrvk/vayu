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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import { useDataFileStore } from "@/stores/data-file-store";
import { useSpecFileStore } from "@/stores/spec-file-store";
import type { Collection, DataFileLocation, SpecFileLocation } from "@/types";
import {
	installFileBindingMirror,
	recordDataFileHash,
	rememberDataFileReading,
	reviseDataFileBinding,
	writeFileBinding,
} from "./file-bindings";
import { useUpdateCollectionMutation } from "./collections";
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

	it("writes the new hash to every binding at that path, and only there", async () => {
		useDataFileStore.setState({
			locations: {
				col_1: USERS,
				col_2: { path: USERS.path, fileName: "users.csv", castNumbers: true },
				col_3: { path: "/home/u/plans.csv", fileName: "plans.csv" },
			},
		});

		recordDataFileHash(USERS.path, NEW, client);

		await vi.waitFor(() => expect(updateCollection).toHaveBeenCalledTimes(2));
		expect(updateCollection.mock.calls.map(([update]) => update)).toEqual([
			{ id: "col_1", dataFile: { ...USERS, hash: NEW } },
			// How the file is read rides along: the binding is replaced whole.
			{
				id: "col_2",
				dataFile: { path: USERS.path, fileName: "users.csv", castNumbers: true, hash: NEW },
			},
		]);
	});

	it("writes nothing for an unchanged hash, another path, or a value that is not a digest", async () => {
		useDataFileStore.setState({ locations: { col_1: USERS } });

		recordDataFileHash(USERS.path, USERS.hash!, client);
		recordDataFileHash("/home/u/elsewhere.csv", NEW, client);
		recordDataFileHash(USERS.path, "users.csv", client);
		// Anything queued would have been sent by the time a write queued after it is.
		await writeFileBinding(client, { id: "col_2", specFile: SPEC });

		expect(updateCollection.mock.calls).toEqual([[{ id: "col_2", specFile: SPEC }]]);
	});

	it("logs a refused write rather than throwing into the read it rode on", async () => {
		useDataFileStore.setState({ locations: { col_1: USERS } });
		updateCollection.mockRejectedValue(new Error("engine unreachable"));

		expect(() => recordDataFileHash(USERS.path, NEW, client)).not.toThrow();

		await vi.waitFor(() => expect(logError).toHaveBeenCalledTimes(1));
		expect((logError.mock.calls[0][0] as Error).message).toBe("engine unreachable");
	});
});

/*
 * The engine replaces a binding object whole, so a write built from the binding
 * before an earlier write landed puts the earlier binding back (#2765). Each
 * case holds the first write's answer open, queues the second, then lands the
 * first. Mutation checks: send each write at once (drop
 * `afterEarlierBindingWrites`) and every case fails on the second write's
 * payload or on its being sent at all; build the hash write from the binding
 * `recordDataFileHash` saw rather than the one `reviseDataFileBinding` reads at
 * send time and the toggle case fails; drop the send-time `measures` check and
 * the pick case writes the old file's hash onto the new one.
 */
describe("binding writes to one collection go out one at a time", () => {
	const NEW = "d".repeat(64);
	const PLANS: DataFileLocation = { path: "/home/u/plans.csv", fileName: "plans.csv" };

	/** The engine, answering each update only when the test lands it. */
	function heldEngine() {
		const held: Array<() => void> = [];
		let landed = 0;
		/** How many writes had landed when each one was sent. */
		const landedAtSend: number[] = [];
		updateCollection.mockImplementation(
			(update: { id: string; dataFile?: DataFileLocation | null }) => {
				landedAtSend.push(landed);
				return new Promise((resolve) =>
					held.push(() =>
						resolve(collection(update.id, { dataFile: update.dataFile ?? undefined }))
					)
				);
			}
		);
		return {
			sent: () => updateCollection.mock.calls.map(([update]) => update as unknown),
			landedAtSend,
			/** Land the oldest write, once it has been sent. */
			async landNext() {
				await vi.waitFor(() => expect(held.length).toBeGreaterThan(0));
				landed += 1;
				held.shift()!();
			},
		};
	}

	/** Once every write queued for `col_1` so far has settled: a revision that sends nothing. */
	const queueDrained = () => reviseDataFileBinding(client, "col_1", () => undefined);

	beforeEach(() => {
		uninstall = installFileBindingMirror(client);
		setList([collection("col_1", { dataFile: USERS })]);
	});

	it("drops a hash write once a pick ahead of it names another file", async () => {
		const engine = heldEngine();
		const pick = writeFileBinding(client, { id: "col_1", dataFile: PLANS });
		recordDataFileHash(USERS.path, NEW, client);
		await engine.landNext();
		await pick;
		await queueDrained();

		expect(engine.sent()).toEqual([{ id: "col_1", dataFile: PLANS }]);
		expect(useDataFileStore.getState().locations.col_1).toEqual(PLANS);
	});

	it("keeps a toggle that landed ahead of a hash write", async () => {
		const engine = heldEngine();
		const toggle = rememberDataFileReading(client, {
			id: "col_1",
			path: USERS.path,
			castNumbers: true,
		});
		recordDataFileHash(USERS.path, NEW, client);
		await engine.landNext();
		await toggle;
		await engine.landNext();
		await queueDrained();

		expect(engine.landedAtSend).toEqual([0, 1]);
		expect(engine.sent()).toEqual([
			{ id: "col_1", dataFile: { ...USERS, castNumbers: true } },
			{ id: "col_1", dataFile: { ...USERS, castNumbers: true, hash: NEW } },
		]);
		expect(useDataFileStore.getState().locations.col_1).toEqual({
			...USERS,
			castNumbers: true,
			hash: NEW,
		});
	});

	it("keeps a hash that landed ahead of a toggle", async () => {
		const engine = heldEngine();
		recordDataFileHash(USERS.path, NEW, client);
		const toggle = rememberDataFileReading(client, {
			id: "col_1",
			path: USERS.path,
			castNumbers: true,
		});
		await engine.landNext();
		await engine.landNext();
		await toggle;

		expect(engine.landedAtSend).toEqual([0, 1]);
		expect(engine.sent()[1]).toEqual({
			id: "col_1",
			dataFile: { ...USERS, hash: NEW, castNumbers: true },
		});
	});

	/*
	 * A pick or a Remove goes through the collection update hook. Mutation
	 * check: send a binding update from its `mutationFn` straight to the API
	 * and the declare goes out while the hash write ahead of it is in flight.
	 */
	it("holds a declare made through the update hook behind a write in flight", async () => {
		const engine = heldEngine();
		const { result } = renderHook(() => useUpdateCollectionMutation(), {
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={client}>{children}</QueryClientProvider>
			),
		});
		recordDataFileHash(USERS.path, NEW, client);
		await vi.waitFor(() => expect(engine.sent()).toHaveLength(1));

		const declare = result.current.mutateAsync({
			id: "col_1",
			dataSchema: { columns: ["plan"], fileName: "plans.csv", declaredAt: 1 },
			dataFile: PLANS,
		});
		await engine.landNext();
		await engine.landNext();
		await declare;

		expect(engine.landedAtSend).toEqual([0, 1]);
		expect(useDataFileStore.getState().locations.col_1).toEqual(PLANS);
	});

	it("sends the next write after one the engine refused", async () => {
		updateCollection.mockRejectedValueOnce(new Error("engine unreachable"));
		updateCollection.mockImplementation(async (update) => collection(update.id));

		const refused = writeFileBinding(client, { id: "col_1", dataFile: PLANS });
		const next = writeFileBinding(client, { id: "col_1", dataFile: null });

		await expect(refused).rejects.toThrow("engine unreachable");
		await expect(next).resolves.toMatchObject({ id: "col_1" });
		expect(updateCollection).toHaveBeenCalledTimes(2);
	});
});
