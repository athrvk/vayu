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
 * Four things have to be true for the contract to be worth having, and each is
 * one a later phase builds on rather than a detail of this tab:
 *
 *  - **Picking a file declares the columns of the file that was picked** - not
 *    a re-parse, not the file name, and with no button between the pick and the
 *    write. Phase 2 validates `{{data.*}}` against exactly this list, so a list
 *    assembled from anywhere else validates the wrong file.
 *  - **Remove clears the contract, a refusal does not.** Both end in the
 *    picker's `onSelect(null)`; only Remove is the user withdrawing the file
 *    (#2043).
 *  - **Clear sends `null`, not `{}`.** The engine reads absent as "keep"; a
 *    cleared contract is only expressible as an explicit null that survives to
 *    the wire, and `{}` would read as "keep" too.
 *  - **The path is bound, and the rows are not.** The collection row holds
 *    where the file is (`dataFile`, written with the columns, #2765) so the Run
 *    dialog can pre-fill; nothing anywhere holds what was in it.
 *
 * And then what the remembered path is *for*, here (issue #727): the tab whose
 * job is the comparison reads the file back itself, rather than rendering
 * "Declared from users.csv" beside "Nothing to compare yet" and waiting to be
 * handed the same file again. That re-read is a preview: it never declares.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useDataFileStore } from "@/stores";
import type { Collection, DataFileLocation } from "@/types";

const mutation = {
	mutate: vi.fn(),
	isPending: false,
	isError: false,
	error: null as Error | null,
};

vi.mock("@/queries/collections", () => ({
	useUpdateCollectionMutation: () => mutation,
}));

/**
 * The engine data caps, as `useDataFileLimits` reads them. Empty leaves the
 * seeds standing, which is every case but the row-cap one below.
 */
const configEntries: { key: string; value: string }[] = [];

vi.mock("@/queries", () => ({
	// The picker and the tab's own re-read both read the caps through
	// `useDataFileLimits`.
	useConfigQuery: () => ({ data: { entries: configEntries } }),
	// The referenced-columns panel (issue #600) reads both of these. It has its
	// own suite - `ColumnAudit.test.tsx` - so here it only has to render: no
	// collections means no subtree to audit, and no requests means every
	// declared column reports as unreferenced.
	useCollectionsQuery: () => ({ data: [] }),
	useFullCollectionRequests: () => ({
		requestsByCollection: new Map(),
		isLoading: false,
	}),
	// Read by `useVariableResolver`, which the panel's collision note (issue
	// #1007) calls with no collection variables and no environment - empty is
	// enough to render; the note's own behaviour is `ColumnAudit.test.tsx`'s
	// business, not this suite's.
	useGlobalsQuery: () => ({ data: { variables: {} } }),
	useEnvironmentsQuery: () => ({ data: [] }),
}));

const { default: DataTab } = await import("./DataTab");

/** The file the collection is bound to, as the row carries it; none by default. */
let boundFile: DataFileLocation | undefined;

const collection = (dataSchema?: Collection["dataSchema"]): Collection =>
	({
		id: "col_1",
		name: "Checkout flow",
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		elements: [],
		dataSchema,
		...(boundFile ? { dataFile: boundFile } : {}),
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
	configEntries.length = 0;
	mutation.mutate.mockClear();
	mutation.isPending = false;
	mutation.isError = false;
	mutation.error = null;
	boundFile = undefined;
	useDataFileStore.setState({ locations: {} });
	vi.stubGlobal("electronAPI", { getFilePath: () => "/home/u/users.csv" });
});

describe("declaring a contract", () => {
	it("declares the picked file's columns with no button press, and binds where it is", async () => {
		render(<DataTab collection={collection()} />);
		await pickFile("users.csv", "id,email\n1,a@b.c");

		const [payload] = mutation.mutate.mock.calls[0];
		expect(payload.id).toBe("col_1");
		expect(payload.dataSchema.columns).toEqual(["id", "email"]);
		expect(payload.dataSchema.fileName).toBe("users.csv");
		expect(typeof payload.dataSchema.declaredAt).toBe("number");

		// In the same write as the columns: a path pointing at a file whose
		// columns were never declared would pre-fill a run with a file nothing
		// can be checked against.
		expect(payload.dataFile).toEqual({
			path: "/home/u/users.csv",
			fileName: "users.csv",
			// SHA-256 of the picked bytes (issue #2051), so MCP can name the
			// file's content beside its path.
			hash: "88e94c0d2bbe183d98748a0fb71c5704bcb28e216797d6cd71855ca88378ab1a",
			// A pick is a new file, read as text until the user says otherwise.
			castNumbers: false,
		});
	});

	it("never puts a row anywhere that persists", async () => {
		render(<DataTab collection={collection()} />);
		await pickFile("users.csv", "id,email\n1,secret@example.test");
		succeed();

		// The payload is everything the row stores, binding included: no cell of
		// the file may be in it.
		expect(JSON.stringify(mutation.mutate.mock.calls[0][0])).not.toContain(
			"secret@example.test"
		);
	});

	it("offers no declare button before a file has been picked", () => {
		render(<DataTab collection={collection()} />);
		expect(screen.queryByRole("button", { name: /declare columns|re-declare/i })).toBeNull();
	});

	it("declares without a path outside Electron, where there is none to remember", async () => {
		vi.stubGlobal("electronAPI", undefined);
		render(<DataTab collection={collection()} />);
		await pickFile("users.csv", "id\n1");
		succeed();

		expect(mutation.mutate.mock.calls[0][0].dataSchema.columns).toEqual(["id"]);
		expect(mutation.mutate.mock.calls[0][0].dataFile).toBeNull();
	});

	it("forgets a stale bound path when the picked file carries none", async () => {
		boundFile = { path: "/home/u/old.csv", fileName: "old.csv" };
		// No `readDataFile`: the file is not re-read, so the picker offers Choose file.
		vi.stubGlobal("electronAPI", { getFilePath: () => "" });
		render(<DataTab collection={collection({ columns: ["id"], fileName: "old.csv" })} />);
		await pickFile("new.csv", "plan\nfree");

		expect(mutation.mutate.mock.calls[0][0].dataFile).toBeNull();
	});

	it("keeps the preview and a retry when the declare fails", async () => {
		render(<DataTab collection={collection()} />);
		await pickFile("users.csv", "id,email\n1,a@b.c");
		expect(mutation.mutate).toHaveBeenCalledTimes(1);

		// The first-time button is the retry path: a failed write leaves the file
		// previewed and the contract undeclared, and it is the only way back to
		// the write short of picking the file again.
		fireEvent.click(screen.getByRole("button", { name: /declare columns/i }));

		expect(mutation.mutate).toHaveBeenCalledTimes(2);
		expect(mutation.mutate.mock.calls[1][0].dataSchema.columns).toEqual(["id", "email"]);
	});
});

describe("removing the file", () => {
	/** A contract from users.csv, its file bound and re-read into the picker. */
	function renderDeclared() {
		boundFile = { path: "/home/u/users.csv", fileName: "users.csv" };
		vi.stubGlobal("electronAPI", {
			readDataFile: vi.fn(() =>
				Promise.resolve({
					bytes: new TextEncoder().encode("id,email\n1,a@b.c"),
					fileName: "users.csv",
				})
			),
			getFilePath: () => "/home/u/plans.csv",
		});
		const view = render(
			<DataTab collection={collection({ columns: ["id", "email"], fileName: "users.csv" })} />
		);
		return view;
	}

	it("clears the contract and the bound file in one write", async () => {
		renderDeclared();
		fireEvent.click(await screen.findByRole("button", { name: /remove/i }));

		expect(mutation.mutate.mock.calls[0][0]).toEqual({
			id: "col_1",
			dataSchema: null,
			dataFile: null,
		});
	});

	it("then declares the next file picked, with the old columns gone", async () => {
		const view = renderDeclared();
		fireEvent.click(await screen.findByRole("button", { name: /remove/i }));
		succeed();
		// The mutation landed: the collection comes back with no contract.
		boundFile = undefined;
		view.rerender(<DataTab collection={collection({})} />);

		await pickFile("plans.csv", "plan,price\nfree,0");

		const [payload] = mutation.mutate.mock.calls[mutation.mutate.mock.calls.length - 1];
		expect(payload.dataSchema.columns).toEqual(["plan", "price"]);
		expect(payload.dataFile).toEqual({
			path: "/home/u/plans.csv",
			fileName: "plans.csv",
			hash: "b7359bc0b274253135286ab911139026c671d4a11f8df272d20bd5342fa265c0",
			castNumbers: false,
		});
	});

	it("only drops the preview when there is no contract to clear", async () => {
		render(<DataTab collection={collection()} />);
		await pickFile("users.csv", "id\n1");

		fireEvent.click(screen.getByRole("button", { name: /remove/i }));

		// The one call is the pick's own declare; Remove added none, and in
		// particular no `dataSchema: null`.
		expect(mutation.mutate).toHaveBeenCalledTimes(1);
		expect(mutation.mutate.mock.calls[0][0].dataSchema).not.toBeNull();
	});

	it("leaves the contract alone when the picker refuses a file", async () => {
		configEntries.push({ key: "maxScenarioDataRows", value: "1" });
		render(<DataTab collection={collection({ columns: ["id"], fileName: "users.csv" })} />);

		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [new File(["id\n1\n2"], "big.csv")] } });

		await waitFor(() => expect(screen.getByText(/maxScenarioDataRows/)).toBeTruthy());
		// A refusal ends in `onSelect(null)` too; it is not the user withdrawing
		// the file the contract was read from.
		expect(mutation.mutate).not.toHaveBeenCalled();
	});
});

describe("an existing contract", () => {
	it("shows its columns and offers no declare button until a file differs", () => {
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
		expect(screen.queryByRole("button", { name: /declare columns|re-declare/i })).toBeNull();
	});

	it("clears with an explicit null, and forgets the bound file", () => {
		boundFile = { path: "/home/u/users.csv", fileName: "users.csv" };
		render(<DataTab collection={collection({ columns: ["id"] })} />);

		fireEvent.click(screen.getByRole("button", { name: /clear/i }));

		// `null`, not `{}` and not an omission: absent means "keep" to the engine.
		expect(mutation.mutate.mock.calls[0][0]).toEqual({
			id: "col_1",
			dataSchema: null,
			dataFile: null,
		});
	});

	it("offers no Clear when there is nothing declared to clear", () => {
		render(<DataTab collection={collection()} />);
		expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();
	});

	it("diffs a picked file against the declared columns, in both directions", async () => {
		render(<DataTab collection={collection({ columns: ["id", "email"] })} />);
		await pickFile("other.csv", "id,nickname\n1,addy");
		expect(mutation.mutate).toHaveBeenCalledTimes(1);

		expect(screen.getByText(/missing a declared column: email/i)).toBeTruthy();
		expect(screen.getByText(/does not declare: nickname/i)).toBeTruthy();
		// Until the write lands the contract is the old one, so the mismatch shows
		// and re-declaring stays one click away - the fix, and the retry.
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
		// Nothing differs, so there is nothing for a button to write.
		expect(screen.queryByRole("button", { name: /declare columns|re-declare/i })).toBeNull();
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
		boundFile = { path, fileName };
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
		// Where the binding points is on screen, and not struck: the file read.
		expect(screen.getByText("/home/u/users.csv").className).not.toContain("line-through");
		// Mutation check for the auto-read: without it this callout is what shows,
		// which is the reported incoherence.
		expect(screen.queryByText(/Nothing to compare yet/i)).toBeNull();
		// Opening the tab compares; it is never a declaration.
		expect(mutation.mutate).not.toHaveBeenCalled();
	});

	it("reads the remembered file the way its binding says (#2540)", async () => {
		boundFile = { path: "/home/u/users.csv", fileName: "users.csv", castNumbers: true };
		const read = bridge(() => csv("id\n007", "users.csv"));
		vi.stubGlobal("electronAPI", { readDataFile: read, getFilePath: () => "" });

		render(<DataTab collection={collection({ columns: ["id"] })} />);

		await waitFor(() => expect(screen.getByText(/Numbers are read as numbers/)).toBeTruthy());
		expect(screen.getByRole("cell", { name: "7" })).toBeTruthy();
		expect(
			(screen.getByRole("checkbox", { name: /Read numbers as numbers/ }) as HTMLInputElement)
				.checked
		).toBe(true);
	});

	it("writes a toggle to the binding without re-declaring (#2540)", async () => {
		remember();
		// The writer finds the binding by id, through the store that mirrors the
		// collections list in the app.
		useDataFileStore.setState({ locations: { col_1: boundFile! } });
		const read = bridge(() => csv("id\n007", "users.csv"));
		vi.stubGlobal("electronAPI", { readDataFile: read, getFilePath: () => "" });

		render(<DataTab collection={collection({ columns: ["id"] })} />);
		fireEvent.click(await screen.findByRole("checkbox", { name: /Read numbers as numbers/ }));

		expect(screen.getByRole("cell", { name: "7" })).toBeTruthy();
		// The binding alone: no `dataSchema`, so the contract is not re-declared.
		expect(mutation.mutate.mock.calls).toEqual([
			[
				{
					id: "col_1",
					dataFile: {
						path: "/home/u/users.csv",
						fileName: "users.csv",
						castNumbers: true,
					},
				},
			],
		]);
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
		// And the path the binding names stays on screen, struck too: after a
		// restore on another machine it is the one thing that says which file
		// to find (#2765). Mutation check: drop the "Bound to" line and this
		// fails.
		expect(screen.getByText("/home/u/gone.csv").className).toContain("line-through");
		expect(screen.queryByText(/Couldn't read the data file/i)).toBeNull();
		expect(screen.getByText(/Nothing to compare yet/i)).toBeTruthy();
		// No Remove (nothing is selected), so Clear is how this contract is reset.
		expect(screen.getByRole("button", { name: /clear/i })).toBeTruthy();
	});

	/*
	 * The row cap on the tab's own re-read (issue #751). The picker refuses a
	 * hand-picked file over `maxScenarioDataRows` naming the setting; a file
	 * declared under a higher cap and re-read under a lower one has to meet the
	 * same refusal, rather than being compared against the contract and then
	 * refused by `POST /runs` at the next run.
	 */
	it("refuses a remembered file over the row cap, naming the setting", async () => {
		remember("/home/u/grown.csv", "grown.csv");
		vi.stubGlobal("electronAPI", {
			readDataFile: bridge(() => csv("id\n1\n2\n3", "grown.csv")),
			getFilePath: () => "",
		});
		configEntries.push({ key: "maxScenarioDataRows", value: "2" });

		render(<DataTab collection={collection({ columns: ["id"], fileName: "grown.csv" })} />);

		await waitFor(() =>
			expect(screen.getByText(/3 rows, over the 2[\s\S]*maxScenarioDataRows/)).toBeTruthy()
		);
		// Refused, not compared: no preview of a file no run can use.
		expect(screen.getByText(/Nothing to compare yet/i)).toBeTruthy();
	});

	it("compares that same file once the setting is raised", async () => {
		remember("/home/u/grown.csv", "grown.csv");
		vi.stubGlobal("electronAPI", {
			readDataFile: bridge(() => csv("id\n1\n2\n3", "grown.csv")),
			getFilePath: () => "",
		});
		configEntries.push({ key: "maxScenarioDataRows", value: "3" });

		render(<DataTab collection={collection({ columns: ["id"], fileName: "grown.csv" })} />);

		await waitFor(() => expect(screen.getByText("grown.csv")).toBeTruthy());
		expect(screen.queryByText(/maxScenarioDataRows/)).toBeNull();
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

	it("does not re-read, or replace the pick, when a pick declares and writes the store", async () => {
		const read = bridge(() => csv("id\n1", "users.csv"));
		vi.stubGlobal("electronAPI", {
			readDataFile: read,
			getFilePath: () => "/home/u/other.csv",
		});

		render(<DataTab collection={collection({ columns: ["id"] })} />);
		await pickFile("other.csv", "id,extra\n1,x");
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
