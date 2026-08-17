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
 * Declaring a collection's data contract (issue #599).
 *
 * Three things have to be true for the contract to be worth having, and each is
 * one a later phase builds on rather than a detail of this tab:
 *
 *  - **Declare writes the columns of the file that was previewed** - not a
 *    re-parse, not the file name. Phase 2 validates `{{data.*}}` against exactly
 *    this list, so a list assembled from anywhere else validates the wrong file.
 *  - **Clear sends `null`, not `{}`.** The engine reads absent as "keep"; a
 *    cleared contract is only expressible as an explicit null that survives to
 *    the wire, and `{}` would read as "keep" too.
 *  - **The path is remembered, and the rows are not.** The store holds where the
 *    file is so the Run dialog can pre-fill; nothing anywhere holds what was in
 *    it.
 *
 * And then what the remembered path is *for*, here (issue #727): the tab whose
 * job is the comparison reads the file back itself, rather than rendering
 * "Declared from users.csv" beside "Nothing to compare yet" and waiting to be
 * handed the same file again.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useDataFileStore } from "@/stores";
import type { Collection } from "@/types";

const mutation = {
	mutate: vi.fn(),
	isPending: false,
	isError: false,
	error: null as Error | null,
};

vi.mock("@/queries/collections", () => ({
	useUpdateCollectionMutation: () => mutation,
}));

vi.mock("@/queries", () => ({
	// The picker reads the two engine caps through `useDataFileLimits`; empty
	// entries leave it on the seeds, which no case here goes near.
	useConfigQuery: () => ({ data: { entries: [] } }),
	// The referenced-columns panel (issue #600) reads both of these. It has its
	// own suite - `ColumnAudit.test.tsx` - so here it only has to render: no
	// collections means no subtree to audit, and no requests means every
	// declared column reports as unreferenced.
	useCollectionsQuery: () => ({ data: [] }),
	useMultipleCollectionRequests: () => ({
		requestsByCollection: new Map(),
		isLoading: false,
	}),
}));

const { default: DataTab } = await import("./DataTab");

const collection = (dataSchema?: Collection["dataSchema"]): Collection =>
	({
		id: "col_1",
		name: "Checkout flow",
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		preRequestScript: "",
		postRequestScript: "",
		dataSchema,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	}) as Collection;

/** Drive the hidden <input type="file"> the way the browser would. */
async function pickFile(name: string, text: string) {
	const input = document.querySelector('input[type="file"]') as HTMLInputElement;
	expect(input).toBeTruthy();
	fireEvent.change(input, { target: { files: [new File([text], name)] } });
	await waitFor(() => expect(screen.getByText(name)).toBeTruthy());
}

/** Resolve the mutation the way TanStack would, running the caller's onSuccess. */
function succeed() {
	const [, options] = mutation.mutate.mock.calls[mutation.mutate.mock.calls.length - 1];
	options?.onSuccess?.({});
}

beforeEach(() => {
	mutation.mutate.mockClear();
	mutation.isPending = false;
	mutation.isError = false;
	mutation.error = null;
	useDataFileStore.setState({ locations: {} });
	vi.stubGlobal("electronAPI", { getFilePath: () => "/home/u/users.csv" });
});

describe("declaring a contract", () => {
	it("writes the previewed file's columns and remembers where the file is", async () => {
		render(<DataTab collection={collection()} />);
		await pickFile("users.csv", "id,email\n1,a@b.c");

		fireEvent.click(screen.getByRole("button", { name: /declare columns/i }));

		const [payload] = mutation.mutate.mock.calls[0];
		expect(payload.id).toBe("col_1");
		expect(payload.dataSchema.columns).toEqual(["id", "email"]);
		expect(payload.dataSchema.fileName).toBe("users.csv");
		expect(typeof payload.dataSchema.declaredAt).toBe("number");

		// Remembered only once the write lands: a path pointing at a file whose
		// columns were never declared would pre-fill a run with a file nothing
		// can be checked against.
		expect(useDataFileStore.getState().locations.col_1).toBeUndefined();
		succeed();
		expect(useDataFileStore.getState().locations.col_1).toEqual({
			path: "/home/u/users.csv",
			fileName: "users.csv",
		});
	});

	it("never puts a row anywhere that persists", async () => {
		render(<DataTab collection={collection()} />);
		await pickFile("users.csv", "id,email\n1,secret@example.test");

		fireEvent.click(screen.getByRole("button", { name: /declare columns/i }));
		succeed();

		// Neither the payload nor the store may carry a cell of the file.
		expect(JSON.stringify(mutation.mutate.mock.calls[0][0])).not.toContain(
			"secret@example.test"
		);
		expect(JSON.stringify(useDataFileStore.getState().locations)).not.toContain(
			"secret@example.test"
		);
	});

	it("cannot declare before a file has been previewed", () => {
		render(<DataTab collection={collection()} />);
		expect(screen.getByRole("button", { name: /declare columns/i })).toHaveProperty(
			"disabled",
			true
		);
	});

	it("declares without a path outside Electron, where there is none to remember", async () => {
		vi.stubGlobal("electronAPI", undefined);
		render(<DataTab collection={collection()} />);
		await pickFile("users.csv", "id\n1");

		fireEvent.click(screen.getByRole("button", { name: /declare columns/i }));
		succeed();

		expect(mutation.mutate.mock.calls[0][0].dataSchema.columns).toEqual(["id"]);
		expect(useDataFileStore.getState().locations.col_1).toBeUndefined();
	});
});

describe("an existing contract", () => {
	it("shows its columns and offers to re-declare rather than to declare", () => {
		render(
			<DataTab collection={collection({ columns: ["id", "email"], fileName: "u.csv" })} />
		);

		// `getAllByText`: the referenced-columns panel below lists the same names
		// again, bucketed by whether a request uses them (issue #600).
		expect(screen.getAllByText("id").length).toBeGreaterThan(0);
		expect(screen.getAllByText("email").length).toBeGreaterThan(0);
		// The name is its own element so it can be struck through when the file
		// turns out to be unreadable (issue #727), hence the two assertions.
		expect(screen.getByText(/Declared from/)).toBeTruthy();
		expect(screen.getByText("u.csv").className).not.toContain("line-through");
		expect(screen.getByRole("button", { name: /re-declare/i })).toBeTruthy();
	});

	it("clears with an explicit null, and forgets the remembered file", () => {
		useDataFileStore.setState({
			locations: { col_1: { path: "/home/u/users.csv", fileName: "users.csv" } },
		});
		render(<DataTab collection={collection({ columns: ["id"] })} />);

		fireEvent.click(screen.getByRole("button", { name: /clear/i }));

		// `null`, not `{}` and not an omission: absent means "keep" to the engine.
		expect(mutation.mutate.mock.calls[0][0]).toEqual({ id: "col_1", dataSchema: null });
		succeed();
		expect(useDataFileStore.getState().locations.col_1).toBeUndefined();
	});

	it("offers no Clear when there is nothing declared to clear", () => {
		render(<DataTab collection={collection()} />);
		expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();
	});

	it("diffs a picked file against the declared columns, in both directions", async () => {
		render(<DataTab collection={collection({ columns: ["id", "email"] })} />);
		await pickFile("other.csv", "id,nickname\n1,addy");

		expect(screen.getByText(/missing a declared column: email/i)).toBeTruthy();
		expect(screen.getByText(/does not declare: nickname/i)).toBeTruthy();
		// A mismatch never blocks re-declaring - re-declaring is the fix for it.
		expect(screen.getByRole("button", { name: /re-declare/i })).toHaveProperty(
			"disabled",
			false
		);
	});

	it("says nothing about a file that matches", async () => {
		render(<DataTab collection={collection({ columns: ["id", "email"] })} />);
		await pickFile("users.csv", "email,id\na@b.c,1");

		expect(screen.queryByText(/missing a declared column/i)).toBeNull();
		expect(screen.queryByText(/does not declare/i)).toBeNull();
	});
});

describe("the remembered file", () => {
	/** The `readDataFile` bridge, answering with a file's bytes the way Electron does. */
	function bridge(impl: (path: string) => { bytes: Uint8Array; fileName: string }) {
		return vi.fn((path: string) => Promise.resolve(impl(path)));
	}

	const csv = (text: string, fileName: string) => ({
		bytes: new TextEncoder().encode(text),
		fileName,
	});

	function remember(path = "/home/u/users.csv", fileName = "users.csv") {
		useDataFileStore.setState({ locations: { col_1: { path, fileName } } });
	}

	it("compares the remembered file with zero clicks", async () => {
		remember();
		const read = bridge(() => csv("id,nickname\n1,addy", "users.csv"));
		vi.stubGlobal("electronAPI", { readDataFile: read, getFilePath: () => "" });

		render(<DataTab collection={collection({ columns: ["id", "email"] })} />);

		// The whole point: the diff both ways, against a file nobody re-picked.
		await waitFor(() =>
			expect(screen.getByText(/missing a declared column: email/i)).toBeTruthy()
		);
		expect(screen.getByText(/does not declare: nickname/i)).toBeTruthy();
		expect(read).toHaveBeenCalledWith("/home/u/users.csv");
		// Mutation check for the auto-read: without it this callout is what shows,
		// which is the reported incoherence.
		expect(screen.queryByText(/Nothing to compare yet/i)).toBeNull();
	});

	it("says it is reading rather than claiming there is nothing to compare", async () => {
		remember();
		let release: (value: { bytes: Uint8Array; fileName: string }) => void = () => {};
		vi.stubGlobal("electronAPI", {
			readDataFile: () =>
				new Promise<{ bytes: Uint8Array; fileName: string }>((resolve) => {
					release = resolve;
				}),
			getFilePath: () => "",
		});

		render(<DataTab collection={collection({ columns: ["id"] })} />);

		// Before the first paint, not one tick after it: a flash of the callout is
		// the same lie, one frame long.
		expect(screen.getByText(/Reading users\.csv/i)).toBeTruthy();
		expect(screen.queryByText(/Nothing to compare yet/i)).toBeNull();

		release(csv("id\n1", "users.csv"));
		await waitFor(() => expect(screen.getByText("users.csv")).toBeTruthy());
	});

	it("degrades to the pick state with the name struck through when the file is gone", async () => {
		remember("/home/u/gone.csv", "gone.csv");
		vi.stubGlobal("electronAPI", {
			readDataFile: () => Promise.reject(new Error("ENOENT: no such file")),
			getFilePath: () => "",
		});

		render(<DataTab collection={collection({ columns: ["id"], fileName: "gone.csv" })} />);

		await waitFor(() => expect(screen.getByText(/ENOENT/)).toBeTruthy());
		// A note beside the name, not a wall in place of the tab: the declared
		// name is struck through and the picker is still usable.
		const name = screen.getByText("gone.csv");
		expect(name.className).toContain("line-through");
		expect(screen.queryByText(/Could not read the data file/i)).toBeNull();
		expect(screen.getByText(/Nothing to compare yet/i)).toBeTruthy();
		expect(screen.getByRole("button", { name: /re-declare/i })).toBeTruthy();
	});

	it("reads nothing without a contract to compare against", () => {
		remember();
		const read = bridge(() => csv("id\n1", "users.csv"));
		vi.stubGlobal("electronAPI", { readDataFile: read, getFilePath: () => "" });

		render(<DataTab collection={collection()} />);

		expect(read).not.toHaveBeenCalled();
	});

	it("leaves the picker standing outside Electron, where there is no path to re-read", () => {
		remember();
		vi.stubGlobal("electronAPI", undefined);

		render(<DataTab collection={collection({ columns: ["id"] })} />);

		// Not a spinner that never resolves - the browser degradation is the
		// pick-a-file state, unchanged.
		expect(screen.queryByText(/Reading/i)).toBeNull();
		expect(screen.getByText(/Nothing to compare yet/i)).toBeTruthy();
	});

	it("does not re-read, or replace the pick, when Declare writes the store", async () => {
		const read = bridge(() => csv("id\n1", "users.csv"));
		vi.stubGlobal("electronAPI", {
			readDataFile: read,
			getFilePath: () => "/home/u/other.csv",
		});

		render(<DataTab collection={collection({ columns: ["id"] })} />);
		await pickFile("other.csv", "id,extra\n1,x");

		fireEvent.click(screen.getByRole("button", { name: /re-declare/i }));
		succeed();

		// The store now holds a path, but re-reading it here would replace the
		// file the user is looking at with the one they just declared from.
		expect(read).not.toHaveBeenCalled();
		expect(screen.getByText("other.csv")).toBeTruthy();
	});
});

describe("a failed save", () => {
	it("says so rather than leaving the user believing it landed", async () => {
		mutation.isError = true;
		mutation.error = new Error("engine unreachable");
		render(<DataTab collection={collection()} />);

		expect(screen.getByText(/Couldn't save the data contract/i)).toBeTruthy();
		expect(screen.getByText(/engine unreachable/)).toBeTruthy();
	});
});
