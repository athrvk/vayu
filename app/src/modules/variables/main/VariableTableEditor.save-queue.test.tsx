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
 * map, a save for an entity that is gone ending as a failure, and a conflicted
 * key left out of every save until the user picks a side.
 *
 * The harness is `VariableTableEditor.status-stomp.test.tsx`'s.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";

import { TooltipProvider } from "@/components/ui";
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
		mutate: (...args: unknown[]) => updateEnvironment(...args),
		mutateAsync: vi.fn(),
	}),
	useSetActiveEnvironmentMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteEnvironmentMutation: () => ({
		mutate: vi.fn(),
		mutateAsync: vi.fn(),
		isPending: false,
	}),
	useUpdateCollectionMutation: () => ({
		mutate: (...args: unknown[]) =>
			updateCollection(...(args as Parameters<typeof updateCollection>)),
		mutateAsync: vi.fn(),
	}),
}));

const sessionStore = { activeEnvironmentId: null, setActiveEnvironmentId: vi.fn() };

vi.mock("@/stores", async () => {
	const saveStore =
		await vi.importActual<typeof import("@/stores/save-store")>("@/stores/save-store");
	const toastStore =
		await vi.importActual<typeof import("@/stores/toast-store")>("@/stores/toast-store");
	return {
		useSaveStore: saveStore.useSaveStore,
		useToastStore: toastStore.useToastStore,
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
