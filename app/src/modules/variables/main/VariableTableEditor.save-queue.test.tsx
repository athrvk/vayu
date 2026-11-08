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
 * How the editor's saves follow one another (#3353), against the real save
 * store: one in flight at a time so the baseline is always the last saved
 * map, a save for an entity that is gone ending as a failure, a conflicted key
 * left out of every save until the user picks a side, and a failed save
 * retried on `useSaveManager`'s backoff.
 *
 * The harness is `VariableTableEditor.status-stomp.test.tsx`'s.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";

import { TIMING } from "@/config/timing";
import { TooltipProvider } from "@/components/ui";
import { ApiError } from "@/services/http-client";
import { useClientSettingsStore } from "@/stores/client-settings-store";
import { resetSaveStoreForTests, useSaveStore } from "@/stores/save-store";
import { useToastStore } from "@/stores/toast-store";
import VariableTableEditor from "./VariableTableEditor";
import type { Collection, Environment, VariableValue } from "@/types";

interface MutateOptions {
	onSuccess: () => void;
	onError: (error: Error) => void;
}

interface SentSave {
	variables: Record<string, VariableValue>;
	opts: MutateOptions;
	settled: boolean;
}

/** Every save the editor sent, in order; each is landed or failed by hand. */
const sent: SentSave[] = [];
const updateCollection = vi.fn(
	(payload: { variables: Record<string, VariableValue> }, opts: MutateOptions) => {
		sent.push({ variables: payload.variables, opts, settled: false });
	}
);
const updateEnvironment = vi.fn();

vi.mock("@/queries", () => ({
	useGlobalsQuery: () => ({ data: undefined, isLoading: false, error: null }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useUpdateEnvironmentMutation: () => ({
		mutate: vi.fn(),
		// Answers through the per-call callbacks, as a mounted mutation does.
		mutateAsync: (...args: unknown[]) => {
			updateEnvironment(...args);
			return new Promise(() => {});
		},
	}),
	useSetActiveEnvironmentMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteEnvironmentMutation: () => ({
		mutate: vi.fn(),
		mutateAsync: vi.fn(),
		isPending: false,
	}),
	useUpdateCollectionMutation: () => ({
		mutate: vi.fn(),
		// Answers through the per-call callbacks, as a mounted mutation does.
		mutateAsync: (...args: unknown[]) => {
			updateCollection(...(args as Parameters<typeof updateCollection>));
			return new Promise(() => {});
		},
	}),
}));

const sessionStore = { activeEnvironmentId: null, setActiveEnvironmentId: vi.fn() };

vi.mock("@/stores", async () => {
	const saveStore =
		await vi.importActual<typeof import("@/stores/save-store")>("@/stores/save-store");
	const toastStore =
		await vi.importActual<typeof import("@/stores/toast-store")>("@/stores/toast-store");
	const settingsStore = await vi.importActual<typeof import("@/stores/client-settings-store")>(
		"@/stores/client-settings-store"
	);
	return {
		useSaveStore: saveStore.useSaveStore,
		useToastStore: toastStore.useToastStore,
		useClientSettingsStore: settingsStore.useClientSettingsStore,
		useSessionStore: Object.assign(() => sessionStore, { getState: () => sessionStore }),
	};
});

vi.mock("@/modules/variables/variables-store", () => ({
	useVariablesStore: () => ({ selectedCategory: null, setSelectedCategory: vi.fn() }),
}));

function variable(value: string, createdAt: number, enabled = true): VariableValue {
	return { value, enabled, secret: false, type: "string", createdAt };
}

function collectionOf(variables: Record<string, VariableValue>, id = "col_1"): Collection {
	return {
		id,
		name: id,
		description: "",
		order: 0,
		variables,
		auth: { mode: "none" },
		elements: [],
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	};
}

function mount(collection: Collection) {
	const ui = (c: Collection) => (
		<TooltipProvider>
			<VariableTableEditor config={{ type: "collection", collection: c }} />
		</TooltipProvider>
	);
	const view = render(ui(collection));
	return { ...view, rerenderWith: (c: Collection) => view.rerender(ui(c)) };
}

const valueFields = () => screen.getAllByPlaceholderText("value") as HTMLInputElement[];
const store = () => useSaveStore.getState();

function typeAndLeave(field: HTMLElement, value: string) {
	fireEvent.change(field, { target: { value } });
	fireEvent.blur(field);
}

const lastSent = () => sent[sent.length - 1];

function settle(save: SentSave, how: (opts: MutateOptions) => void) {
	save.settled = true;
	act(() => how(save.opts));
}

/**
 * Lands every save still out, newest first, until none is left: the order that
 * moved the baseline back while two could be in flight at once.
 */
function landNewestFirst() {
	for (;;) {
		const open = sent.filter((save) => !save.settled);
		if (open.length === 0) return;
		settle(open[open.length - 1], (opts) => opts.onSuccess());
	}
}

beforeEach(() => {
	sent.length = 0;
	updateCollection.mockClear();
	updateEnvironment.mockClear();
	resetSaveStoreForTests();
	useToastStore.setState({ toasts: [] });
});

describe("two saves asked for back to back", () => {
	/*
	 * Mutation check: start every save at once instead of queueing it (call
	 * `runSaves` from `requestSave` unconditionally) and this reds twice over -
	 * two saves in flight, and once the older one lands last its map is the
	 * baseline, so the echo of the newer save reads as "Changed elsewhere".
	 */
	it("run one at a time, and leave the baseline at the later map", () => {
		const { rerenderWith } = mount(collectionOf({ host: variable("example.com", 1000) }));

		typeAndLeave(valueFields()[0], "example.org");
		fireEvent.click(screen.getByRole("checkbox", { name: "Enable host" }));
		expect(sent).toHaveLength(1);

		landNewestFirst();
		expect(sent).toHaveLength(2);
		// The queued save read the rows when it started: both edits are in it.
		expect(lastSent().variables.host).toMatchObject({ value: "example.org", enabled: false });
		expect(store().status).toBe("saved");

		// A new edit, then the cache echo of the later save: nothing moved but
		// this editor's own write, so there is nothing to choose between.
		fireEvent.change(valueFields()[0], { target: { value: "example.net" } });
		rerenderWith(collectionOf({ host: variable("example.org", 1000, false) }));
		expect(screen.queryByText(/changed elsewhere/i)).toBeNull();

		// And a genuine write elsewhere to the same key still is one.
		rerenderWith(collectionOf({ host: variable("agent.example", 1000, false) }));
		expect(screen.getByText(/changed elsewhere: host/i)).toBeInTheDocument();
	});
});

describe("a save queued for a collection the editor has left", () => {
	/*
	 * Mutation check: report `saving` for it as for a live save and this reds -
	 * that report takes the discarded id back, and the failure then sits on the
	 * Dock as "Not saved" for rows no editor holds.
	 */
	it("is still sent, and its failure is a toast, not an ownerless 'Not saved'", () => {
		const { rerenderWith } = mount(collectionOf({ host: variable("example.com", 1000) }));
		typeAndLeave(valueFields()[0], "example.org");
		fireEvent.click(screen.getByRole("checkbox", { name: "Enable host" }));
		rerenderWith(collectionOf({ region: variable("eu-west-1", 1000) }, "col_2"));
		expect(store().unsaved.has("collection-col_1")).toBe(false);

		settle(sent[0], (opts) => opts.onSuccess());
		expect(sent).toHaveLength(2);
		expect(lastSent().variables.host).toMatchObject({ value: "example.org", enabled: false });
		settle(lastSent(), (opts) => opts.onError(new Error("database is locked")));

		expect(store().unsaved.has("collection-col_1")).toBe(false);
		expect(store().status).not.toBe("error");
		expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
			"Couldn't save - database is locked",
		]);
	});

	/*
	 * An id the editor left with nothing unsaved was never abandoned, so the
	 * store would record a failure reported under it. Mutation check: report a
	 * left id's failure through `reportFailed` and this reds.
	 */
	it("leaves no entry for an id that had nothing unsaved", () => {
		const { rerenderWith } = mount(collectionOf({ host: variable("example.com", 1000) }));
		typeAndLeave(valueFields()[0], "example.org");
		rerenderWith(collectionOf({ region: variable("eu-west-1", 1000) }, "col_2"));
		// Cmd+S on the clean second collection, queued behind the first's save.
		act(() => {
			void store().triggerSave();
		});
		rerenderWith(collectionOf({ zone: variable("a", 1000) }, "col_3"));

		settle(sent[0], (opts) => opts.onSuccess());
		expect(sent).toHaveLength(2);
		settle(lastSent(), (opts) => opts.onError(new Error("database is locked")));

		expect(store().unsaved.has("collection-col_2")).toBe(false);
		expect(store().status).not.toBe("error");
	});
});

describe("a save that throws before it is sent", () => {
	/*
	 * Mutation check: drop the try/catch in `startSave` and this reds - the
	 * throw leaves a save "in flight" that never settles, so the next one only
	 * queues and is never sent.
	 */
	it("fails, and does not hold up the next save", () => {
		mount(collectionOf({ host: variable("example.com", 1000) }));
		updateCollection.mockImplementationOnce(() => {
			throw new Error("serialiser broke");
		});
		// The throw reaches React's event handler only if `startSave` lets it out.
		const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

		typeAndLeave(valueFields()[0], "example.org");
		expect(store().status).toBe("error");
		expect(store().lastErrorMessage).toBe("Couldn't save - serialiser broke");

		typeAndLeave(valueFields()[0], "example.net");
		expect(sent).toHaveLength(1);
		expect(lastSent().variables.host.value).toBe("example.net");
		quiet.mockRestore();
	});
});

describe("a save for an environment that is gone", () => {
	/*
	 * Mutation check: drop the `!sendTo` branch in `startSave` (the old code had
	 * no final else) and this reds - the status sits on "saving" with no save
	 * sent and none ever settling.
	 */
	it("ends as a failure instead of saving forever", async () => {
		render(
			<TooltipProvider>
				<VariableTableEditor config={{ type: "environment", environment: undefined }} />
			</TooltipProvider>
		);
		typeAndLeave(screen.getByLabelText("Variable name"), "host");

		expect(updateEnvironment).not.toHaveBeenCalled();
		expect(store().status).toBe("error");
		expect(store().lastErrorMessage).toBe("Couldn't save - this environment no longer exists");
		expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
			"Couldn't save - this environment no longer exists",
		]);

		// The quit flush counts it rather than waiting out its ceiling.
		let flushed!: Awaited<ReturnType<ReturnType<typeof store>["flushAll"]>>;
		await act(async () => {
			flushed = await store().flushAll();
		});
		expect(flushed).toEqual({ saved: 0, failed: 1, pending: 0 });
	});

	it("leaves an environment that is there to save as before", () => {
		const environment: Environment = {
			id: "env_1",
			name: "staging",
			description: "",
			variables: { host: variable("example.com", 1000) },
			isActive: false,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		};
		render(
			<TooltipProvider>
				<VariableTableEditor config={{ type: "environment", environment }} />
			</TooltipProvider>
		);
		typeAndLeave(valueFields()[0], "example.org");

		expect(updateEnvironment).toHaveBeenCalledTimes(1);
		expect(store().status).toBe("saving");
	});
});

describe("a conflict open while the user saves something else", () => {
	function openConflict() {
		const view = mount(
			collectionOf({ host: variable("example.com", 1000), token: variable("abc", 2000) })
		);
		fireEvent.change(valueFields()[0], { target: { value: "mine" } });
		view.rerenderWith(
			collectionOf({ host: variable("theirs", 1000), token: variable("abc", 2000) })
		);
		expect(screen.getByText(/changed elsewhere: host/i)).toBeInTheDocument();
		return view;
	}

	/*
	 * Mutation check, two of them: keep the conflicted key in the payload (drop
	 * the `delete changes[key]` loop in `planSave`) and the payload carries
	 * "mine"; clear the conflicts on success (`setConflicts([])` in `landSave`)
	 * and the callout goes with the save. Either reds here.
	 */
	it("survives the save, and the conflicted key is not in it", () => {
		const { rerenderWith } = openConflict();

		typeAndLeave(valueFields()[1], "xyz");
		expect(sent).toHaveLength(1);
		expect(lastSent().variables.host.value).toBe("theirs");
		expect(lastSent().variables.token.value).toBe("xyz");

		landNewestFirst();
		expect(screen.getByText(/changed elsewhere: host/i)).toBeInTheDocument();
		expect(valueFields()[0].value).toBe("mine");
		// The held edit is not on disk, and the Dock says so.
		expect(store().status).toBe("pending");

		// The cache echo of that save does not close it either.
		rerenderWith(collectionOf(lastSent().variables));
		expect(screen.getByText(/changed elsewhere: host/i)).toBeInTheDocument();
		expect(valueFields()[0].value).toBe("mine");
	});

	it("is closed by the user's choice, which the next save then carries", () => {
		openConflict();
		typeAndLeave(valueFields()[1], "xyz");
		landNewestFirst();

		fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));

		expect(sent).toHaveLength(2);
		expect(lastSent().variables.host.value).toBe("mine");
		expect(lastSent().variables.token.value).toBe("xyz");
		expect(screen.queryByText(/changed elsewhere/i)).toBeNull();
	});
});

describe("Take theirs on a row whose name the user changed", () => {
	const nameFields = () => screen.getAllByLabelText("Variable name") as HTMLInputElement[];

	/** Edit row 0 as `edit` does, then let another writer change `host`. */
	function conflictAfter(edit: () => void) {
		const view = mount(collectionOf({ host: variable("example.com", 1000) }));
		edit();
		view.rerenderWith(collectionOf({ host: variable("agent.example", 1000) }));
		expect(screen.getByText(/changed elsewhere: host/i)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Take theirs" }));
		expect(screen.queryByText(/changed elsewhere/i)).toBeNull();
		return lastSent().variables;
	}

	/*
	 * Mutation check: match the row by its raw `key` alone (the old
	 * `row.key === key`) and both of these red - the renamed row is not found
	 * and the save still deletes `host`; the padded one is not found and the
	 * save still sends the user's value.
	 */
	it("takes the other writer's value for the stored name, undoing the rename", () => {
		const sentVariables = conflictAfter(() =>
			fireEvent.change(nameFields()[0], { target: { value: "hostname" } })
		);

		expect(sentVariables.host?.value).toBe("agent.example");
		expect(sentVariables.hostname).toBeUndefined();
		expect(nameFields()[0].value).toBe("host");
		expect(valueFields()[0].value).toBe("agent.example");
	});

	it("finds the row while its name still carries the padding being typed", () => {
		const sentVariables = conflictAfter(() => {
			fireEvent.change(nameFields()[0], { target: { value: "host " } });
			fireEvent.change(valueFields()[0], { target: { value: "mine" } });
		});

		expect(sentVariables.host?.value).toBe("agent.example");
		expect(valueFields()[0].value).toBe("agent.example");
	});
});

describe("a failed save", () => {
	const delayMs = () => useClientSettingsStore.getState().autoSave.delayMs;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	async function advance(ms: number) {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(ms);
		});
	}

	function failLast(error: Error = new Error("database is locked")) {
		settle(lastSent(), (opts) => opts.onError(error));
	}

	function editAndFail(error?: Error) {
		const view = mount(collectionOf({ host: variable("example.com", 1000) }));
		typeAndLeave(valueFields()[0], "example.org");
		failLast(error);
		expect(store().status).toBe("error");
		return view;
	}

	/*
	 * Mutation check: return before arming the timer in `scheduleRetry` and the
	 * second save never goes out.
	 */
	it("retries on the auto-save backoff, doubling, until one lands", async () => {
		editAndFail();

		await advance(delayMs() - 1);
		expect(sent).toHaveLength(1);
		await advance(1);
		expect(sent).toHaveLength(2);
		expect(lastSent().variables.host.value).toBe("example.org");

		failLast();
		await advance(2 * delayMs() - 1);
		expect(sent).toHaveLength(2);
		await advance(1);
		expect(sent).toHaveLength(3);

		settle(lastSent(), (opts) => opts.onSuccess());
		expect(store().status).toBe("saved");
		await advance(TIMING.SAVE_RETRY_MAX_DELAY_MS);
		expect(sent).toHaveLength(3);
	});

	/*
	 * Mutation check: retry a `final` outcome like any other failure and this
	 * reds - the 400 goes out again, and toasts again.
	 */
	it("is not retried when the engine refused the payload", async () => {
		editAndFail(new ApiError(400, "bad_request", "invalid variable name"));

		await advance(TIMING.SAVE_RETRY_MAX_DELAY_MS);

		expect(sent).toHaveLength(1);
		expect(store().status).toBe("error");
	});

	/*
	 * Mutation check: drop the `clearRetry()` from the switch/unmount cleanup
	 * and the rows the editor let go of are sent again.
	 */
	it("stops retrying once the editor switches to another collection", async () => {
		const { rerenderWith } = editAndFail();

		rerenderWith(collectionOf({ region: variable("eu-west-1", 1000) }, "col_2"));
		await advance(TIMING.SAVE_RETRY_MAX_DELAY_MS);

		expect(sent).toHaveLength(1);
	});

	it("stops retrying once the editor unmounts", async () => {
		const { unmount } = editAndFail();

		unmount();
		await advance(TIMING.SAVE_RETRY_MAX_DELAY_MS);

		expect(sent).toHaveLength(1);
	});
});
