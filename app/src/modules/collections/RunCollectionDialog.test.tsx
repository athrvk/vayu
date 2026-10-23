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
 * Starting a collection run.
 *
 * The payload is the point: `POST /runs` accepts two different shapes and the
 * scenario one has to carry the discriminator, the collection, both options and
 * the environment the rest of the app resolves against. What follows a `202` is
 * the other half - the tab and the stream both have to be pointed at the new
 * run, or the user watches a run they cannot see.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import RunCollectionDialog from "./RunCollectionDialog";
import {
	useClientSettingsStore,
	useDashboardStore,
	useDataFileStore,
	useSessionStore,
	useTabsStore,
} from "@/stores";
import { DEFAULT_LOAD_TEST_CEILINGS } from "@/constants/load-test";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import type { Collection, Request } from "@/types";
import { BUDGETS_EXPLAINER } from "@/modules/request-builder/components/LoadTestConfigDialog/budgets";

const mutate = vi.fn();
const startRunState = {
	mutate,
	isPending: false,
	error: null as Error | null,
};

/**
 * The two engine data caps, as `useDataFileLimits` reads them. Empty by default,
 * which leaves the seeds standing - only the row-cap cases below set one, and
 * they set it to a number the engine does not seed so a hardcoded copy could not
 * pass for the fetched value.
 */
const configEntries: { key: string; value: string }[] = [];

/**
 * The collection tree, for the contract walk (issue #729). Empty by default:
 * the dialog is handed the collection it runs, so a root collection declaring
 * its own contract resolves without the query having answered - only the
 * ancestor cases below seed rows.
 */
const collections: Collection[] = [];

/**
 * The stored requests per collection, for the audit of which columns they
 * reference that a picked file lacks (issue #2050). Empty by default.
 */
const requestsByCollection = new Map<string, Request[]>();

vi.mock("@/queries", () => ({
	useStartScenarioRunMutation: () => startRunState,
	// The picker and the pre-fill both read the caps through `useDataFileLimits`.
	useConfigQuery: () => ({ data: { entries: configEntries } }),
	useCollectionsQuery: () => ({ data: collections }),
	useFullCollectionRequests: () => ({ requestsByCollection, isLoading: false }),
}));

/**
 * The contract write a pick or a Remove makes (issue #2050) - the collection
 * update, not the start-run `mutate` above. Mutable, so a case can make it fail.
 */
const updateCollection = {
	mutate: vi.fn(),
	isPending: false,
	isError: false,
	error: null as Error | null,
};
/** How the bound file is read: a write of its own, built when it is sent. */
const readingUpdate = {
	mutate: vi.fn(),
	isPending: false,
	isError: false,
	error: null as Error | null,
};
vi.mock("@/queries/collections", () => ({
	useUpdateCollectionMutation: () => updateCollection,
	useDataFileReadingMutation: () => readingUpdate,
}));

/**
 * The hash a re-read records against the bound path (#2051). Which bindings
 * that writes is `file-bindings.test.ts`'s; here it only has to be asked.
 */
const recordDataFileHash = vi.fn();
vi.mock("@/queries/file-bindings", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries/file-bindings")>()),
	recordDataFileHash: (...args: unknown[]) => recordDataFileHash(...args),
}));

const startMonitoring = vi.fn();
const startLoadMonitoring = vi.fn();
vi.mock("@/services", () => ({
	scenarioRunService: { startMonitoring: (id: string) => startMonitoring(id) },
	loadTestService: { startMonitoring: (id: string) => startLoadMonitoring(id) },
}));

const COLLECTION = {
	id: "col_1",
	name: "Checkout flow",
	parentId: null,
} as unknown as Collection;

/** Resolve the mutation the way TanStack would, running the caller's onSuccess. */
function succeedWith(runId: string) {
	const calls = mutate.mock.calls;
	const [, options] = calls[calls.length - 1];
	options.onSuccess({ runId, status: "running" });
}

beforeEach(() => {
	configEntries.length = 0;
	collections.length = 0;
	requestsByCollection.clear();
	mutate.mockClear();
	updateCollection.mutate.mockReset();
	readingUpdate.mutate.mockReset();
	updateCollection.isPending = false;
	updateCollection.isError = false;
	updateCollection.error = null;
	startMonitoring.mockClear();
	startLoadMonitoring.mockClear();
	startRunState.isPending = false;
	startRunState.error = null;
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useSessionStore.setState({ activeEnvironmentId: null });
	useClientSettingsStore.getState().setLoadTestCeilings({ ...DEFAULT_LOAD_TEST_CEILINGS });
	localStorage.removeItem(STORAGE_KEYS.LAST_LOAD_TEST_CONFIG);
});

describe("the payload", () => {
	it("sends the scenario block with both options and the active environment", () => {
		useSessionStore.setState({ activeEnvironmentId: "env_9" });
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);

		fireEvent.click(screen.getByRole("switch", { name: /include nested collections/i }));
		fireEvent.change(screen.getByRole("spinbutton", { name: /iterations/i }), {
			target: { value: "3" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

		expect(mutate).toHaveBeenCalledTimes(1);
		expect(mutate.mock.calls[0][0]).toEqual({
			scenario: {
				source: "collection",
				collectionId: "col_1",
				recursive: true,
				iterations: 3,
			},
			environmentId: "env_9",
		});
	});

	it("omits environmentId entirely when no environment is active", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

		// Not `environmentId: null` - an explicit null is a value the engine has
		// to have an opinion about, and "no environment" is the absence of one.
		expect(mutate.mock.calls[0][0]).not.toHaveProperty("environmentId");
	});

	it("defaults to one iteration and no recursion", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

		expect(mutate.mock.calls[0][0].scenario).toMatchObject({
			recursive: false,
			iterations: 1,
		});
	});
});

/**
 * The contract gate (issue #720). The flag was readable on a stored report and
 * writable by nobody while `docs/app/openapi.md` told users to set it, so what
 * these pin is that the dialog is now its writer - and that it stays absent
 * unless asked for, which is what keeps "absent means the engine's default"
 * true for a payload written before the toggle existed.
 */
describe("failing steps on schema errors", () => {
	const toggle = () =>
		fireEvent.click(screen.getByRole("switch", { name: /fail steps on schema errors/i }));

	it("sends the flag once the user turns it on", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		toggle();
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

		expect(mutate.mock.calls[0][0]).toMatchObject({ failOnSchemaError: true });
	});

	it("omits it entirely while it is off", () => {
		// Not `failOnSchemaError: false`: the engine's default is off, so absent
		// already says it, and a key written on every run would claim a gate was
		// considered by a payload from before this control existed.
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

		expect(mutate.mock.calls[0][0]).not.toHaveProperty("failOnSchemaError");
	});

	it("is not offered for a load run, and is not sent if it was on first", () => {
		// Only the design-mode runner demotes a step on a schema failure - the
		// load executor validates once the run has drained - so a load payload
		// carrying the flag would promise a gate nothing applies.
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		toggle();
		fireEvent.click(screen.getByRole("switch", { name: /load test/i }));

		expect(screen.queryByRole("switch", { name: /fail steps on schema errors/i })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
		expect(mutate.mock.calls[0][0]).not.toHaveProperty("failOnSchemaError");
	});
});

/**
 * Ending an iteration at a script error (issue #2526). Off is the engine's
 * default, so the key rides the payload only when the user asked for it.
 */
describe("stopping the iteration on a script error", () => {
	const name = /stop the iteration on a script error/i;
	const toggle = () => fireEvent.click(screen.getByRole("switch", { name }));

	it("sends the flag once the user turns it on", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		toggle();
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

		expect(mutate.mock.calls[0][0]).toMatchObject({ stopOnError: true });
	});

	it("omits it entirely while it is off", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

		expect(mutate.mock.calls[0][0]).not.toHaveProperty("stopOnError");
	});

	it("is not offered for a load run, and is not sent if it was on first", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		toggle();
		fireEvent.click(screen.getByRole("switch", { name: /load test/i }));

		expect(screen.queryByRole("switch", { name })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
		expect(mutate.mock.calls[0][0]).not.toHaveProperty("stopOnError");
	});

	it("is a switch of its own, apart from the schema gate", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		toggle();
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

		expect(mutate.mock.calls[0][0]).not.toHaveProperty("failOnSchemaError");
	});
});

describe("invalid iterations", () => {
	it("refuses a zero, a fraction and an empty field rather than sending them", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		const field = screen.getByRole("spinbutton", { name: /iterations/i });
		const run = screen.getByRole("button", { name: /^run$/i });

		for (const bad of ["0", "1.5", "", "-2"]) {
			fireEvent.change(field, { target: { value: bad } });
			expect(run).toHaveProperty("disabled", true);
			expect(screen.getByText(/whole number of 1 or more/i)).toBeTruthy();
			fireEvent.click(run);
		}

		expect(mutate).not.toHaveBeenCalled();
	});

	it("re-enables once the field is valid again", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		const field = screen.getByRole("spinbutton", { name: /iterations/i });

		fireEvent.change(field, { target: { value: "0" } });
		fireEvent.change(field, { target: { value: "2" } });

		expect(screen.getByRole("button", { name: /^run$/i })).toHaveProperty("disabled", false);
		expect(screen.queryByText(/whole number of 1 or more/i)).toBeNull();
	});
});

describe("after the engine answers", () => {
	it("opens the run's tab and attaches the live stream", async () => {
		const onOpenChange = vi.fn();
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={onOpenChange} />);
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

		succeedWith("run_42");

		expect(startMonitoring).toHaveBeenCalledWith("run_42");
		await waitFor(() => {
			expect(useTabsStore.getState().openTabs).toHaveLength(1);
		});
		expect(useTabsStore.getState().openTabs[0]).toMatchObject({
			type: "run",
			entityId: "run_42",
		});
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("shows the engine's rejection in place rather than closing on it", () => {
		// Every scenario rejection is a 400 raised before a run row exists, and
		// the message names the step that would not compose - which is the thing
		// the user has to go and fix, so it cannot be a toast that scrolls away.
		startRunState.error = new Error("Step 3 'Checkout' failed to compose: unknown variable");
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);

		expect(screen.getByText(/couldn't start the run/i)).toBeTruthy();
		expect(screen.getByText(/unknown variable/i)).toBeTruthy();
	});
});

describe("opening it again", () => {
	/*
	 * The tree mounts this only once a folder has been chosen and unmounts it on
	 * close, so a second opening is a fresh mount. This drives it exactly that
	 * way - an always-mounted dialog would carry the first folder's Recursive and
	 * Iterations into the second, which is what the mount/unmount prevents.
	 */
	it("starts from the defaults rather than the previous folder's choices", () => {
		const first = render(
			<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />
		);

		fireEvent.click(screen.getByRole("switch", { name: /include nested collections/i }));
		fireEvent.change(screen.getByRole("spinbutton", { name: /iterations/i }), {
			target: { value: "5" },
		});
		first.unmount();

		const other = { ...COLLECTION, id: "col_2", name: "Other" } as Collection;
		render(<RunCollectionDialog collection={other} onOpenChange={vi.fn()} />);

		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
		expect(mutate.mock.calls[0][0].scenario).toMatchObject({
			collectionId: "col_2",
			recursive: false,
			iterations: 1,
		});
	});
});

/*
 * The data file (issue #402). The engine bounds and rejects a bad set, but by
 * then the run has been asked for - so the contract asserted here is that what
 * the dialog *shows* and what it *sends* come from one parse, and that a file
 * which will not parse produces neither.
 */
describe("a data file", () => {
	/**
	 * Drive the hidden <input type="file"> the way the browser would. Queried
	 * off `document`, not the render container: `DialogContent` portals.
	 */
	async function pickFile(name: string, text: string) {
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		expect(input).toBeTruthy();
		fireEvent.change(input, { target: { files: [new File([text], name)] } });
		// FileReader resolves on a task, not synchronously.
		await waitFor(() => expect(screen.queryByText(name)).toBeTruthy());
	}

	it("sends the previewed rows and omits iterations so the row count decides", async () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		await pickFile("users.csv", "user,id\nada,1\ngrace,2");

		// The preview is the parsed file, not a re-read of the text.
		expect(screen.getByText("ada")).toBeTruthy();
		expect(screen.getByText("grace")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
		expect(mutate.mock.calls[0][0].scenario).toEqual({
			source: "collection",
			collectionId: "col_1",
			recursive: false,
			data: [
				{ user: "ada", id: "1" },
				{ user: "grace", id: "2" },
			],
			// Which file drove the run (issue #2051): its name and the SHA-256
			// of its bytes, never its path - and how it was read (issue #2540).
			dataFileName: "users.csv",
			dataFileHash: "2db0eca7622a0202096a0e1ee4af0bf2a4f91d3f6c6a1e593900962549927551",
			dataFileCastNumbers: false,
		});
		// Omitted, not computed: the engine owns "absent means one pass per row".
		expect(mutate.mock.calls[0][0].scenario).not.toHaveProperty("iterations");
	});

	// A POSIX file name may hold a `\`, which the engine refuses in a
	// `dataFileName` so no path is stored (#2051): the run still starts.
	// Mutation check: send `dataFile.fileName` unfiltered and this fails.
	it("leaves out a file name holding a path separator, keeping the hash", async () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		await pickFile("odd\\name.csv", "user\nada");

		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
		const scenario = mutate.mock.calls[0][0].scenario;
		expect(scenario.dataFileName).toBeUndefined();
		expect(scenario.dataFileHash).toMatch(/^[0-9a-f]{64}$/);
		expect(scenario.data).toEqual([{ user: "ada" }]);
	});

	it("keeps an explicit iteration count and says how many rows go unused", async () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		await pickFile("users.csv", "user\nada\ngrace\nalan");
		fireEvent.change(screen.getByRole("spinbutton", { name: /iterations/i }), {
			target: { value: "1" },
		});

		// The surprise this preview exists to remove: three rows, one pass.
		expect(screen.getByText(/2 of the 3 rows will not be used/i)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
		expect(mutate.mock.calls[0][0].scenario.iterations).toBe(1);
		expect(mutate.mock.calls[0][0].scenario.data).toHaveLength(3);
	});

	it("refuses a file that will not parse, naming the row, and sends nothing", async () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, {
			target: { files: [new File(["user,id\nada"], "ragged.csv")] },
		});

		await waitFor(() => expect(screen.getByText(/Row 1 has 1 value/i)).toBeTruthy());
		// Nothing half-chosen: no preview, and Run is refused.
		expect(screen.queryByText("ragged.csv")).toBeNull();
		expect(screen.getByRole("button", { name: /^run$/i })).toHaveProperty("disabled", true);
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
		expect(mutate).not.toHaveBeenCalled();
	});

	it("returns to a plain run when the file is removed", async () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		await pickFile("users.csv", "user\nada\ngrace");
		fireEvent.click(screen.getByRole("button", { name: /remove/i }));

		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
		expect(mutate.mock.calls[0][0].scenario).not.toHaveProperty("data");
		// The blanked field goes back to 1, so the run is still valid.
		expect(mutate.mock.calls[0][0].scenario.iterations).toBe(1);
	});

	it("clears a pristine 1 on pick, so the field says what the run will do", async () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		await pickFile("users.csv", "user\nada\ngrace\nalan");

		// Emptied, not left contradicting the "3 iterations, one per row" above.
		expect(screen.getByRole("spinbutton", { name: /iterations/i })).toHaveProperty("value", "");
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
		expect(mutate.mock.calls[0][0].scenario).not.toHaveProperty("iterations");
	});

	it("keeps a 1 the user typed, which the value alone cannot tell from the default", async () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		const field = screen.getByRole("spinbutton", { name: /iterations/i });
		// Typed, not left at the default - it happens to be the same string, and
		// clearing it would turn one pass into a full pass per row.
		fireEvent.change(field, { target: { value: "2" } });
		fireEvent.change(field, { target: { value: "1" } });

		await pickFile("users.csv", "user\nada\ngrace\nalan");

		expect(field).toHaveProperty("value", "1");
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
		expect(mutate.mock.calls[0][0].scenario.iterations).toBe(1);
	});

	it("shows only the first ten rows but sends all of them", async () => {
		const rows = Array.from({ length: 12 }, (_, i) => `user-${i}`).join("\n");
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		await pickFile("many.csv", `user\n${rows}`);

		expect(screen.getByText(/first 10 of 12 rows/i)).toBeTruthy();
		expect(screen.queryByText("user-9")).toBeTruthy();
		expect(screen.queryByText("user-10")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
		expect(mutate.mock.calls[0][0].scenario.data).toHaveLength(12);
	});
});

/*
 * The load-test option (issue #357). Same plan, a different executor - so what
 * matters here is that the payload says which one, and that the live surface
 * follows: a load run publishes metric ticks and no `step` events, so attaching
 * the runner tab's stream to it would leave the user watching a view that can
 * never fill.
 */
describe("running the sequence as a load test", () => {
	const enableLoadTest = () =>
		fireEvent.click(screen.getByRole("switch", { name: /load test/i }));

	it("sends a closed-loop mode, the virtual-user count and the duration", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		enableLoadTest();
		fireEvent.change(screen.getByRole("spinbutton", { name: /virtual users/i }), {
			target: { value: "25" },
		});
		fireEvent.change(screen.getByRole("spinbutton", { name: /duration/i }), {
			target: { value: "45" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

		expect(mutate.mock.calls[0][0]).toMatchObject({
			mode: "constant_concurrency",
			concurrency: 25,
			duration: "45s",
			scenario: { source: "collection", collectionId: "col_1" },
		});
	});

	it("sends no mode at all when the switch is off", () => {
		// The engine reads the *presence* of `mode` as "this is a load run", so a
		// design-mode payload must not carry one - not even a falsy one.
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

		expect(mutate.mock.calls[0][0]).not.toHaveProperty("mode");
		expect(mutate.mock.calls[0][0]).not.toHaveProperty("concurrency");
	});

	it("drops the pass count, which a duration-bounded run has no use for", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		fireEvent.change(screen.getByRole("spinbutton", { name: /iterations/i }), {
			target: { value: "7" },
		});
		enableLoadTest();
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

		expect(mutate.mock.calls[0][0].scenario).not.toHaveProperty("iterations");
		// ...and the field itself is gone, rather than sitting there greyed out
		// still showing a number that no longer applies.
		expect(screen.queryByRole("spinbutton", { name: /iterations/i })).toBeNull();
	});

	it("attaches the metrics stream and the dashboard, not the runner tab", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		enableLoadTest();
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

		succeedWith("run_load_7");

		expect(startLoadMonitoring).toHaveBeenCalledWith("run_load_7");
		expect(startMonitoring).not.toHaveBeenCalled();
		expect(useDashboardStore.getState().currentRunId).toBe("run_load_7");
		expect(useTabsStore.getState().openTabs[0]).toMatchObject({ type: "dashboard" });
	});

	/*
	 * Data rows in load mode (issue #449). The rows always rode the payload -
	 * before the engine bound them the picker was describing a file the run
	 * ignored, which is the failure this pair pins from the app side: they must
	 * still be sent, and the copy must describe the semantics a load run
	 * actually has.
	 */
	it("still sends the rows, which a load run now binds one per iteration", async () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		enableLoadTest();

		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, {
			target: { files: [new File(["user\nada\ngrace"], "users.csv")] },
		});
		await waitFor(() => expect(screen.queryByText("users.csv")).toBeTruthy());

		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
		expect(mutate.mock.calls[0][0].scenario.data).toEqual([{ user: "ada" }, { user: "grace" }]);
		// The pass count still has nothing to say about a duration-bounded run.
		expect(mutate.mock.calls[0][0].scenario).not.toHaveProperty("iterations");
	});

	it("hands the dashboard the row count and the file's name and hash, and nothing for a run without a file (#1940, #2051)", async () => {
		const { unmount } = render(
			<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />
		);
		enableLoadTest();
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, {
			target: { files: [new File(["user\nada\ngrace"], "users.csv")] },
		});
		await waitFor(() => expect(screen.queryByText("users.csv")).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
		succeedWith("run_load_8");

		expect(useDashboardStore.getState().loadTestConfig).toMatchObject({
			dataRowCount: 2,
			dataFileName: "users.csv",
			dataFileHash: "eefb4557a05007a7651f212036cde499da3c25508761ba78de983a521b7446e5",
			dataFileCastNumbers: false,
		});
		unmount();

		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		enableLoadTest();
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
		succeedWith("run_load_9");

		expect(useDashboardStore.getState().loadTestConfig?.dataRowCount).toBeUndefined();
		expect(useDashboardStore.getState().loadTestConfig?.dataFileName).toBeUndefined();
		expect(useDashboardStore.getState().loadTestConfig?.dataFileHash).toBeUndefined();
		expect(useDashboardStore.getState().loadTestConfig?.dataFileCastNumbers).toBeUndefined();
	});

	it("describes the rows as a load run binds them, not as iterations", async () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		enableLoadTest();

		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, {
			target: { files: [new File(["user\nada\ngrace"], "users.csv")] },
		});
		await waitFor(() => expect(screen.queryByText("users.csv")).toBeTruthy());

		// "2 iterations, one per row" is design-mode arithmetic: a load run
		// repeats for its duration, so the row count says nothing about length.
		expect(screen.queryByText(/2 iterations, one per row/i)).toBeNull();
		expect(screen.getByText(/bound one per iteration across every virtual user/i)).toBeTruthy();
	});

	it("refuses a virtual-user count or a duration the engine would reject", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		enableLoadTest();
		const run = screen.getByRole("button", { name: /^run$/i });

		for (const bad of ["0", "1.5", "", "-3"]) {
			fireEvent.change(screen.getByRole("spinbutton", { name: /virtual users/i }), {
				target: { value: bad },
			});
			expect(run).toHaveProperty("disabled", true);
			expect(
				screen.getByText(/virtual users must be a whole number from 1 to/i)
			).toBeTruthy();
		}
		fireEvent.change(screen.getByRole("spinbutton", { name: /virtual users/i }), {
			target: { value: "5" },
		});
		fireEvent.change(screen.getByRole("spinbutton", { name: /duration/i }), {
			target: { value: "0" },
		});
		expect(run).toHaveProperty("disabled", true);
		expect(screen.getByText(/duration must be a number from 1 to/i)).toBeTruthy();

		fireEvent.click(run);
		expect(mutate).not.toHaveBeenCalled();
	});
});

/*
 * The load profile of a collection run (issue #2137): the same picker and
 * fields the request dialog uses, narrowed to the three modes a scenario
 * accepts, and spelled the way `StartScenarioRunRequest` reads them - camelCase
 * with `"Ns"` durations, not the snake_case of a single-request payload, which
 * the engine would ignore here.
 */
describe("the load profile of a sequence", () => {
	const enableLoadTest = () =>
		fireEvent.click(screen.getByRole("switch", { name: /load test/i }));
	const profile = () => screen.getByRole("radiogroup", { name: /load profile/i });
	const pick = (name: RegExp) => fireEvent.click(within(profile()).getByRole("radio", { name }));
	const setField = (name: RegExp, value: string) =>
		fireEvent.change(screen.getByRole("spinbutton", { name }), { target: { value } });
	const run = () => fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
	const openLoad = () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		enableLoadTest();
	};

	it("offers the three modes a scenario accepts and none the engine refuses", () => {
		openLoad();
		const names = within(profile())
			.getAllByRole("radio")
			.map((r) => r.textContent);
		expect(names).toHaveLength(3);
		expect(names.join(" ")).not.toMatch(/constant rps|capacity/i);
		expect(
			within(profile()).getByRole("radio", { name: /constant virtual users/i })
		).toHaveAttribute("aria-checked", "true");
	});

	it("starts a plain run as 10 virtual users for 30s, whatever the request dialog saved", () => {
		localStorage.setItem(
			STORAGE_KEYS.LAST_LOAD_TEST_CONFIG,
			JSON.stringify({ mode: "ramp_up", concurrency: 7, duration: 99 })
		);
		openLoad();
		run();

		const payload = mutate.mock.calls[0][0];
		expect(payload).toMatchObject({
			mode: "constant_concurrency",
			concurrency: 10,
			duration: "30s",
		});
		expect(payload).not.toHaveProperty("iterations");
		expect(payload).not.toHaveProperty("startConcurrency");
		expect(payload).not.toHaveProperty("rampUpDuration");
	});

	it("leaves the request dialog's saved config exactly as it was", () => {
		const memo = JSON.stringify({ mode: "capacity", concurrency: 7 });
		localStorage.setItem(STORAGE_KEYS.LAST_LOAD_TEST_CONFIG, memo);
		openLoad();
		pick(/ramp-up/i);
		run();

		expect(localStorage.getItem(STORAGE_KEYS.LAST_LOAD_TEST_CONFIG)).toBe(memo);
	});

	it("sends a ramp with its start, its ramp length and the total, camelCase", () => {
		openLoad();
		pick(/ramp-up/i);
		setField(/^target virtual users/i, "20");
		setField(/start from/i, "2");
		setField(/ramp duration/i, "10");
		setField(/total duration/i, "40");
		run();

		const payload = mutate.mock.calls[0][0];
		expect(payload).toMatchObject({
			mode: "ramp_up",
			concurrency: 20,
			startConcurrency: 2,
			rampUpDuration: "10s",
			duration: "40s",
		});
		expect(payload).not.toHaveProperty("iterations");
		expect(payload).not.toHaveProperty("ramp_duration_seconds");
		expect(payload).not.toHaveProperty("start_concurrency");
	});

	it("sends fixed passes as the top-level total, with no duration", () => {
		openLoad();
		pick(/fixed passes/i);
		setField(/passes through the sequence/i, "60");
		setField(/^virtual users/i, "4");
		run();

		const payload = mutate.mock.calls[0][0];
		expect(payload).toMatchObject({ mode: "iterations", iterations: 60, concurrency: 4 });
		expect(payload).not.toHaveProperty("duration");
	});

	it("keeps the design-mode pass count out of a load run's total, and the reverse", () => {
		// `scenario.iterations` is the sequential runner's count and top-level
		// `iterations` the load executor's; one state each, sent by switch.
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		setField(/iterations/i, "7");
		enableLoadTest();
		pick(/fixed passes/i);
		setField(/passes through the sequence/i, "60");
		run();

		expect(mutate.mock.calls[0][0].iterations).toBe(60);
		expect(mutate.mock.calls[0][0].scenario).not.toHaveProperty("iterations");

		mutate.mockClear();
		enableLoadTest();
		run();
		expect(mutate.mock.calls[0][0]).not.toHaveProperty("mode");
		expect(mutate.mock.calls[0][0]).not.toHaveProperty("iterations");
		expect(mutate.mock.calls[0][0].scenario.iterations).toBe(7);
	});

	it("seeds the dashboard from the same mode and ramp fields it sent", () => {
		openLoad();
		pick(/ramp-up/i);
		setField(/^target virtual users/i, "20");
		setField(/start from/i, "2");
		setField(/total duration/i, "40");
		run();
		succeedWith("run_ramp_1");

		const sent = mutate.mock.calls[0][0];
		expect(useDashboardStore.getState().loadTestConfig).toMatchObject({
			mode: "ramp_up",
			concurrency: sent.concurrency,
			startConcurrency: sent.startConcurrency,
			rampUpDuration: sent.rampUpDuration,
			duration: sent.duration,
		});
	});

	it("seeds the dashboard with the pass total for fixed passes", () => {
		openLoad();
		pick(/fixed passes/i);
		setField(/passes through the sequence/i, "60");
		run();
		succeedWith("run_passes_1");

		const seed = useDashboardStore.getState().loadTestConfig;
		expect(seed).toMatchObject({ mode: "iterations", iterations: 60 });
		expect(seed?.duration).toBeUndefined();
	});

	it("describes the run per switch position and per mode", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		const description = () => document.querySelector('[data-slot="dialog-description"]');
		expect(description()?.textContent).toBe(
			"Every request in this collection runs in order, once per iteration. Variables and cookies carry from one step to the next."
		);

		enableLoadTest();
		expect(description()?.textContent).toBe(
			"Each virtual user walks every request in this collection in order, repeating for the duration. Variables and cookies carry from one step to the next."
		);

		pick(/fixed passes/i);
		expect(description()?.textContent).toMatch(/until the total is reached/);
		expect(description()?.textContent).not.toMatch(/for the duration/);
	});

	it("never calls a pass through the sequence a request", () => {
		openLoad();
		pick(/fixed passes/i);

		expect(screen.queryByLabelText(/^requests$/i)).toBeNull();
		expect(
			screen.getByRole("spinbutton", { name: /passes through the sequence/i })
		).toBeTruthy();
		const summary = screen.getByText(/^Runs the sequence 100 times across 10 virtual users/);
		expect(summary.textContent).not.toMatch(/request/i);
	});

	it("refuses a count above the Settings ceiling before sending anything", () => {
		useClientSettingsStore.getState().setLoadTestCeilings({ concurrency: 50 });
		openLoad();
		setField(/virtual users/i, "51");

		expect(screen.getByRole("button", { name: /^run$/i })).toHaveProperty("disabled", true);
		expect(screen.getByText(/virtual users must be a whole number from 1 to 50/i)).toBeTruthy();
		run();
		expect(mutate).not.toHaveBeenCalled();

		setField(/virtual users/i, "50");
		expect(screen.getByRole("button", { name: /^run$/i })).toHaveProperty("disabled", false);
	});

	it("refuses passes above the ceiling and a duration above it", () => {
		useClientSettingsStore
			.getState()
			.setLoadTestCeilings({ iterations: 500, durationSeconds: 120 });
		openLoad();
		setField(/duration/i, "121");
		expect(screen.getByRole("button", { name: /^run$/i })).toHaveProperty("disabled", true);

		setField(/duration/i, "120");
		pick(/fixed passes/i);
		setField(/passes through the sequence/i, "501");
		expect(screen.getByRole("button", { name: /^run$/i })).toHaveProperty("disabled", true);
		expect(
			screen.getByText(/passes through the sequence must be a whole number/i)
		).toBeTruthy();
	});

	it("refuses a ramp that does not fit its duration or climbs down", () => {
		openLoad();
		pick(/ramp-up/i);
		const runButton = screen.getByRole("button", { name: /^run$/i });

		setField(/ramp duration/i, "60");
		setField(/total duration/i, "30");
		expect(runButton).toHaveProperty("disabled", true);
		expect(screen.getByText(/must be at least the ramp duration/i)).toBeTruthy();

		setField(/total duration/i, "90");
		expect(runButton).toHaveProperty("disabled", false);

		setField(/start from/i, "50");
		expect(runButton).toHaveProperty("disabled", true);
		expect(screen.getByText(/would ramp down/i)).toBeTruthy();
	});
});

/*
 * The `elements` run override (issue #1552, the app-side twin of the engine
 * contract issue #1495 shipped). Top-level on the payload and omitted per
 * field whenever a control is left at the engine's own default - the same
 * "absent means the default" rule the rest of this payload already follows.
 * `timers` applies to a design-mode run and a load run alike (the sequential
 * runner honours it exactly as the load executor does); `scripts` stays
 * load-only, since the design send and the sequential run already run every
 * `script.*` element inline regardless of the choice.
 */
describe("the elements override", () => {
	const enableLoadTest = () =>
		fireEvent.click(screen.getByRole("switch", { name: /load test/i }));

	it("sends no elements override at the default Timers/Scripts values", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		enableLoadTest();
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

		expect(mutate.mock.calls[0][0]).not.toHaveProperty("elements");
	});

	it("never sends a scripts override on a design-mode (non-load) run", () => {
		// Turn Load test on, change Scripts, then off again - the state
		// persists on the component, so this proves the payload gates on
		// `loadTest` and not merely on the control never having rendered.
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		enableLoadTest();
		const scripts = screen.getByRole("radiogroup", { name: /^scripts$/i });
		fireEvent.click(within(scripts).getByRole("radio", { name: /all inline/i }));
		enableLoadTest();
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

		expect(mutate.mock.calls[0][0]).not.toHaveProperty("elements");
	});

	it("sends a Timers override on a design-mode (non-load) run - not gated by Load test", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		const timers = screen.getByRole("radiogroup", { name: /^timers$/i });
		fireEvent.click(within(timers).getByRole("radio", { name: /^off$/i }));
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

		expect(mutate.mock.calls[0][0].elements).toEqual({ timers: "off" });
	});

	it.each([
		{ changed: "Timers only", timers: "off", scripts: null, expected: { timers: "off" } },
		{
			changed: "Scripts only",
			timers: null,
			scripts: /all inline/i,
			expected: { scripts: "allInline" },
		},
		{
			changed: "both Timers and Scripts",
			timers: "off",
			scripts: /all deferred/i,
			expected: { timers: "off", scripts: "allDeferred" },
		},
	])(
		"sends exactly the changed fields on a load run: $changed",
		({ timers, scripts, expected }) => {
			render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
			enableLoadTest();
			if (timers) {
				const group = screen.getByRole("radiogroup", { name: /^timers$/i });
				fireEvent.click(within(group).getByRole("radio", { name: /^off$/i }));
			}
			if (scripts) {
				const group = screen.getByRole("radiogroup", { name: /^scripts$/i });
				fireEvent.click(within(group).getByRole("radio", { name: scripts }));
			}
			fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

			expect(mutate.mock.calls[0][0].elements).toEqual(expected);
		}
	);

	it("picking All inline back to As marked drops the field again", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		enableLoadTest();
		const scripts = screen.getByRole("radiogroup", { name: /^scripts$/i });
		fireEvent.click(within(scripts).getByRole("radio", { name: /all inline/i }));
		fireEvent.click(within(scripts).getByRole("radio", { name: /^as marked$/i }));
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

		expect(mutate.mock.calls[0][0]).not.toHaveProperty("elements");
	});
});

/**
 * Pass/fail budgets (issue #1564): the engine now judges a collection run
 * against `thresholds` the same way it always has a load run, so
 * `RunCollectionDialog` reuses `LoadTestConfigDialog`'s own disclosure and
 * `budgets.ts` helpers rather than a second copy. The budget rules themselves
 * (range checks, the payload shape) are `budgets.test.ts`'s job; these pin the
 * wiring - that a declared budget reaches the payload, that an invalid one
 * blocks Run, and that neither is gated by the Load test switch.
 */
describe("pass/fail budgets", () => {
	const openBudgets = () =>
		fireEvent.click(screen.getByRole("button", { name: /pass\/fail budgets/i }));

	it("says on the closed card that no budget is active, and counts them as they are declared", () => {
		// Mutation check: drop `summary` from the DisclosureCard and both reds.
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		const card = () => screen.getByRole("button", { name: /pass\/fail budgets/i });
		expect(card()).toHaveTextContent("No budgets");

		openBudgets();
		fireEvent.change(screen.getByLabelText(/error rate/i), { target: { value: "0.1" } });
		expect(card()).toHaveTextContent("1 budget active - Error rate at most 0.1%");
		fireEvent.change(screen.getByLabelText(/throughput/i), { target: { value: "1000" } });
		expect(card()).toHaveTextContent("2 budgets active");
	});

	it("uses the explainer the load-test dialog shows, without a latency hint it never seeds", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		openBudgets();

		expect(screen.getByText(BUDGETS_EXPLAINER)).toBeInTheDocument();
		// Nothing seeds p99 here, so the Settings hint would be false.
		expect(screen.queryByText(/SLO threshold/)).not.toBeInTheDocument();
	});

	it("sends no thresholds at all when nothing is declared", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

		expect(mutate.mock.calls[0][0]).not.toHaveProperty("thresholds");
	});

	it("sends every declared budget under the engine's own key", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		openBudgets();
		fireEvent.change(screen.getByLabelText(/error rate/i), { target: { value: "0.1" } });
		fireEvent.change(screen.getByLabelText(/throughput/i), { target: { value: "1000" } });
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

		expect(mutate.mock.calls[0][0].thresholds).toEqual({
			maxErrorRatePct: 0.1,
			minThroughputRps: 1000,
		});
	});

	it("blocks Run on an out-of-range budget instead of dropping the field", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		openBudgets();
		fireEvent.change(screen.getByLabelText(/error rate/i), { target: { value: "150" } });

		expect(screen.getByRole("button", { name: /^run$/i })).toHaveProperty("disabled", true);
		expect(screen.getByText(/budget is out of range/i)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
		expect(mutate).not.toHaveBeenCalled();
	});

	it("applies to a load run exactly as it does a design-mode run - not gated by Load test", () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		openBudgets();
		fireEvent.change(screen.getByLabelText(/error rate/i), { target: { value: "0.1" } });
		fireEvent.click(screen.getByRole("switch", { name: /load test/i }));
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

		expect(mutate.mock.calls[0][0].thresholds).toEqual({ maxErrorRatePct: 0.1 });
	});

	/*
	 * `custom.<name>.<stat>` (issue #1579) is judged for a design-mode collection
	 * run exactly as the six fixed budgets above are (issue #1564,
	 * `execute_scenario_run`) - not gated by Load test, same as those.
	 */
	describe("custom metric budgets", () => {
		const addCustomRow = () =>
			fireEvent.click(screen.getByRole("button", { name: /add custom metric budget/i }));

		it("offers rows on a design-mode run, not only once Load test is on", () => {
			render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
			openBudgets();

			expect(
				screen.getByRole("button", { name: /add custom metric budget/i })
			).toBeInTheDocument();
		});

		it.each([
			{ run: "a design-mode run", loadTest: false },
			{ run: "a load run", loadTest: true },
		])("sends a declared row under the engine's own key on $run", ({ loadTest }) => {
			render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
			openBudgets();
			addCustomRow();
			fireEvent.change(screen.getByLabelText(/custom budget 1 metric name/i), {
				target: { value: "checkout_ttfb" },
			});
			fireEvent.change(screen.getByLabelText(/custom budget 1 ceiling/i), {
				target: { value: "120" },
			});
			if (loadTest) fireEvent.click(screen.getByRole("switch", { name: /load test/i }));
			fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

			expect(mutate.mock.calls[0][0].thresholds).toEqual({ "custom.checkout_ttfb.p50": 120 });
		});

		it("blocks Run on a half-filled row, the same way an out-of-range fixed budget does", () => {
			render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
			openBudgets();
			addCustomRow();
			fireEvent.change(screen.getByLabelText(/custom budget 1 ceiling/i), {
				target: { value: "120" },
			});

			expect(screen.getByRole("button", { name: /^run$/i })).toHaveProperty("disabled", true);
			expect(screen.getByText(/budget is out of range/i)).toBeInTheDocument();
		});
	});
});

/*
 * Pre-filling from the collection's declared data file (issue #599).
 *
 * The file is picked once and forgotten today, so a data-driven collection asks
 * for the same file on every run. What is pinned here is that the remembered
 * path is re-read *as part of mount* - the dialog's reset contract is what makes
 * the options predictable, and pre-fill has to live inside it rather than beside
 * it - and that a file which cannot be re-read leaves a usable dialog and a
 * sentence saying so, never an error toast and an empty picker.
 */
describe("pre-filling from the declared data file", () => {
	const withContract = (columns: string[]) =>
		({ ...COLLECTION, dataSchema: { columns } }) as unknown as Collection;

	const remember = (path: string, fileName: string) =>
		useDataFileStore.setState({ locations: { col_1: { path, fileName } } });

	/**
	 * The preload bridge, which exists only inside Electron. `getFilePath` rides
	 * along because the picker asks for it on every hand-picked file - a stub
	 * missing it would be a bridge this app never actually meets.
	 */
	const stubReadDataFile = (impl: (path: string) => Promise<unknown>) =>
		vi.stubGlobal("electronAPI", { readDataFile: impl, getFilePath: () => "" });

	const bytesOf = (text: string) => new TextEncoder().encode(text);

	beforeEach(() => {
		useDataFileStore.setState({ locations: {} });
		vi.unstubAllGlobals();
	});

	it("re-reads the remembered file and sends its rows", async () => {
		// Stored with no hash, read back with one: the read records the hash
		// (#2051), which `useDeclaredDataFile.test.tsx` holds the pre-fill
		// steady across.
		remember("/home/u/users.csv", "users.csv");
		stubReadDataFile(async () => ({
			bytes: bytesOf("user,id\nada,1\ngrace,2"),
			fileName: "users.csv",
			hash: "a".repeat(64),
		}));

		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);

		await waitFor(() => expect(screen.getByText("users.csv")).toBeTruthy());
		expect(screen.getByText("ada")).toBeTruthy();
		// Same rule as a hand-picked file: the pristine 1 becomes one pass per row.
		expect(screen.getByRole("spinbutton", { name: /iterations/i })).toHaveProperty("value", "");

		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
		expect(mutate.mock.calls[0][0].scenario.data).toEqual([
			{ user: "ada", id: "1" },
			{ user: "grace", id: "2" },
		]);
		expect(recordDataFileHash).toHaveBeenCalledWith("/home/u/users.csv", "a".repeat(64));
		// A read of what was declared, not a pick: reopening the dialog writes
		// no contract (issue #2050).
		expect(updateCollection.mutate).not.toHaveBeenCalled();
	});

	it("sends the rows read the way the binding says (#2540)", async () => {
		useDataFileStore.setState({
			locations: {
				col_1: { path: "/home/u/users.csv", fileName: "users.csv", castNumbers: true },
			},
		});
		stubReadDataFile(async () => ({ bytes: bytesOf("user,id\nada,1"), fileName: "users.csv" }));

		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);

		const box = await screen.findByRole("checkbox", { name: /Read numbers as numbers/ });
		expect((box as HTMLInputElement).checked).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
		expect(mutate.mock.calls[0][0].scenario.data).toEqual([{ user: "ada", id: 1 }]);
		// The run records the reading beside the file, so its snapshot says how
		// the rows were typed. Mutation check: drop `dataFileCastNumbers` from
		// `handleRun` and this fails.
		expect(mutate.mock.calls[0][0].scenario.dataFileCastNumbers).toBe(true);
	});

	it("re-parses the sent rows on a toggle and remembers it, declaring nothing", async () => {
		remember("/home/u/users.csv", "users.csv");
		stubReadDataFile(async () => ({ bytes: bytesOf("user,id\nada,1"), fileName: "users.csv" }));

		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		fireEvent.click(await screen.findByRole("checkbox", { name: /Read numbers as numbers/ }));
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

		expect(mutate.mock.calls[0][0].scenario.data).toEqual([{ user: "ada", id: 1 }]);
		// Mutation check: drop `writer.rememberReading` and the next pre-fill
		// reads the file as text again. The reading alone, no contract write.
		expect(readingUpdate.mutate.mock.calls).toEqual([
			[{ id: "col_1", path: "/home/u/users.csv", castNumbers: true }],
		]);
		expect(updateCollection.mutate).not.toHaveBeenCalled();
		// Not a pick: the pre-fill's one-pass-per-row stands.
		expect(screen.getByRole("spinbutton", { name: /iterations/i })).toHaveProperty("value", "");
	});

	it("warns when the pre-filled file does not match the declared columns", async () => {
		remember("/home/u/users.csv", "users.csv");
		stubReadDataFile(async () => ({
			bytes: bytesOf("user,nickname\nada,addy"),
			fileName: "users.csv",
		}));

		render(
			<RunCollectionDialog
				collection={withContract(["user", "email"])}
				onOpenChange={vi.fn()}
			/>
		);

		await waitFor(() =>
			expect(screen.getByText(/missing a declared column: email/i)).toBeTruthy()
		);
		expect(screen.getByText(/does not declare: nickname/i)).toBeTruthy();
		// A mismatch is a warning, never a blocker - the run is still the user's.
		expect(screen.getByRole("button", { name: /^run$/i })).toHaveProperty("disabled", false);
	});

	it("says the file has moved and leaves the picker usable", async () => {
		remember("/home/u/gone.csv", "gone.csv");
		stubReadDataFile(async () => {
			throw new Error("The file is no longer at /home/u/gone.csv - pick it again.");
		});

		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);

		await waitFor(() => expect(screen.getByText(/no longer at/i)).toBeTruthy());
		// Not a blocking refusal: a run without a file is a legal run.
		expect(screen.getByRole("button", { name: /^run$/i })).toHaveProperty("disabled", false);
		expect(screen.getByText(/choose file/i)).toBeTruthy();
	});

	/*
	 * The row cap on the pre-fill path (issue #751).
	 *
	 * A hand-picked file over `maxScenarioDataRows` is refused by the picker
	 * naming the setting; the remembered path was accepted, previewed, and
	 * refused by `POST /runs` at Start - the late failure the preview exists to
	 * move earlier. Lowering the setting reaches the same file, which is why the
	 * cap is read live rather than captured when the file was declared.
	 */
	it("refuses a remembered file that is now over the row cap, naming the setting", async () => {
		configEntries.push({ key: "maxScenarioDataRows", value: "2" });
		remember("/home/u/users.csv", "users.csv");
		stubReadDataFile(async () => ({
			bytes: bytesOf("user\nada\ngrace\nalan"),
			fileName: "users.csv",
		}));

		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);

		await waitFor(() =>
			expect(screen.getByText(/3 rows, over the 2[\s\S]*maxScenarioDataRows/)).toBeTruthy()
		);
		// Nothing pre-filled: the rows the engine would refuse never reach a Run
		// the user can start.
		expect(screen.queryByText("ada")).toBeNull();
		expect(screen.getByText(/choose file/i)).toBeTruthy();
		// A note, not a blocker - a run without a file is still a legal run.
		expect(screen.getByRole("button", { name: /^run$/i })).toHaveProperty("disabled", false);

		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
		expect(mutate.mock.calls[0][0].scenario).not.toHaveProperty("data");
	});

	it("pre-fills the same file once the setting is raised, with no restart", async () => {
		configEntries.push({ key: "maxScenarioDataRows", value: "3" });
		remember("/home/u/users.csv", "users.csv");
		stubReadDataFile(async () => ({
			bytes: bytesOf("user\nada\ngrace\nalan"),
			fileName: "users.csv",
		}));

		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);

		await waitFor(() => expect(screen.getByText("ada")).toBeTruthy());
		expect(screen.queryByText(/maxScenarioDataRows/)).toBeNull();
	});

	it("does nothing when the collection has no remembered file", async () => {
		const read = vi.fn();
		stubReadDataFile(read);

		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);

		expect(read).not.toHaveBeenCalled();
		expect(screen.getByText(/choose file/i)).toBeTruthy();
	});

	it("stands unchanged outside Electron, where there is no path to re-read", async () => {
		remember("/home/u/users.csv", "users.csv");
		vi.stubGlobal("electronAPI", undefined);

		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);

		expect(screen.getByText(/choose file/i)).toBeTruthy();
		expect(screen.queryByText("users.csv")).toBeNull();
	});

	it("keeps a file the user picks over the one that was remembered", async () => {
		remember("/home/u/users.csv", "users.csv");
		stubReadDataFile(async () => {
			throw new Error("The file is no longer at /home/u/users.csv - pick it again.");
		});

		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		await waitFor(() => expect(screen.getByText(/no longer at/i)).toBeTruthy());

		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [new File(["user\nada"], "fresh.csv")] } });

		await waitFor(() => expect(screen.getByText("fresh.csv")).toBeTruthy());
		// The note was about a file that is no longer the one in play.
		expect(screen.queryByText(/no longer at/i)).toBeNull();
	});

	/*
	 * The contract in scope, not the collection's own row (issue #729).
	 *
	 * A sub-collection under a declaring parent binds the parent's rows - the
	 * nearest-declared-ancestor rule the token painter, the completions and
	 * `useSendWithRow` all follow, and the one the engine applies at plan time.
	 * Reading `locations[collection.id]` meant precisely that run got no
	 * pre-fill and no column diff, while every other surface said it was
	 * data-driven.
	 */
	/** The declaring parent, plus the sub-collection row the dialog is handed. */
	const parentDeclaring = (columns: string[]) => {
		collections.push({
			id: "col_parent",
			name: "Parent",
			parentId: null,
			dataSchema: { columns },
		} as unknown as Collection);
		return { ...COLLECTION, parentId: "col_parent" } as Collection;
	};

	it("pre-fills a sub-collection from the file its declaring ancestor remembers", async () => {
		const child = parentDeclaring(["user", "id"]);
		// Picked in the parent's Data tab, which is where the contract lives -
		// the sub-collection has no entry of its own and never will.
		useDataFileStore.setState({
			locations: { col_parent: { path: "/home/u/users.csv", fileName: "users.csv" } },
		});
		stubReadDataFile(async () => ({
			bytes: bytesOf("user,id\nada,1\ngrace,2"),
			fileName: "users.csv",
		}));

		render(<RunCollectionDialog collection={child} onOpenChange={vi.fn()} />);

		await waitFor(() => expect(screen.getByText("users.csv")).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
		expect(mutate.mock.calls[0][0].scenario.data).toEqual([
			{ user: "ada", id: "1" },
			{ user: "grace", id: "2" },
		]);
	});

	it("diffs the pre-filled file against the ancestor's columns", async () => {
		const child = parentDeclaring(["user", "email"]);
		useDataFileStore.setState({
			locations: { col_parent: { path: "/home/u/users.csv", fileName: "users.csv" } },
		});
		stubReadDataFile(async () => ({
			bytes: bytesOf("user,nickname\nada,addy"),
			fileName: "users.csv",
		}));

		render(<RunCollectionDialog collection={child} onOpenChange={vi.fn()} />);

		await waitFor(() =>
			expect(screen.getByText(/missing a declared column: email/i)).toBeTruthy()
		);
		expect(screen.getByText(/does not declare: nickname/i)).toBeTruthy();
	});

	it("stops at a sub-collection that declares a contract of its own", () => {
		// Nearest *declared* ancestor: a collection with its own columns answers
		// for itself, and the parent's remembered file is not its file.
		const child = parentDeclaring(["user"]);
		useDataFileStore.setState({
			locations: { col_parent: { path: "/home/u/users.csv", fileName: "users.csv" } },
		});
		const read = vi.fn();
		stubReadDataFile(read);

		render(
			<RunCollectionDialog
				collection={{ ...child, dataSchema: { columns: ["sku"] } } as Collection}
				onOpenChange={vi.fn()}
			/>
		);

		expect(read).not.toHaveBeenCalled();
		expect(screen.getByText(/choose file/i)).toBeTruthy();
	});
});

/*
 * A pick in this dialog declares the contract from the picked file (issue
 * #2050), the way the Data tab does: for the collection whose contract the run
 * binds against, with Remove clearing it, a refused file touching nothing and
 * the pre-fill (above) writing nothing.
 */
describe("a pick declares the contract", () => {
	async function pickFile(name: string, text: string) {
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [new File([text], name)] } });
		await waitFor(() => expect(screen.queryByText(name)).toBeTruthy());
	}

	const withContract = (columns: string[]) =>
		({ ...COLLECTION, dataSchema: { columns } }) as unknown as Collection;

	/** A stored request of `collectionId` whose URL binds `{{data.<column>}}`. */
	const requestBinding = (collectionId: string, column: string) =>
		({
			id: `req_${collectionId}`,
			collectionId,
			url: `https://api.test/users/{{data.${column}}}`,
			params: [],
			headers: [],
			body: { mode: "none" },
			elements: [],
			auth: { mode: "none" },
		}) as unknown as Request;

	beforeEach(() => {
		useDataFileStore.setState({ locations: {} });
		vi.stubGlobal("electronAPI", { getFilePath: () => "/home/u/plans.csv" });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("picking a file declares its columns for the collection", async () => {
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		await pickFile("plans.csv", "plan,price\nfree,0");

		// Mutation check: drop `writer.declare(next)` from the handler and this reds.
		expect(updateCollection.mutate).toHaveBeenCalledWith({
			id: "col_1",
			dataSchema: {
				columns: ["plan", "price"],
				fileName: "plans.csv",
				declaredAt: expect.any(Number),
			},
			dataFile: expect.objectContaining({ path: "/home/u/plans.csv" }),
		});
	});

	it("declares for the ancestor that holds the contract", async () => {
		collections.push({
			id: "col_p",
			name: "Parent",
			parentId: null,
			dataSchema: { columns: ["id"] },
		} as unknown as Collection);
		const child = { ...COLLECTION, parentId: "col_p" } as Collection;

		render(<RunCollectionDialog collection={child} onOpenChange={vi.fn()} />);
		await pickFile("plans.csv", "plan,price\nfree,0");

		// Mutation check: declare against `collection.id` instead of
		// `declaringCollectionId` and this reds.
		expect(updateCollection.mutate).toHaveBeenCalledWith(
			expect.objectContaining({ id: "col_p" })
		);
	});

	it("Remove clears the contract, forgets the path and puts Iterations back to 1", async () => {
		useDataFileStore.setState({
			locations: { col_1: { path: "/home/u/users.csv", fileName: "users.csv" } },
		});
		vi.stubGlobal("electronAPI", {
			getFilePath: () => "",
			readDataFile: async () => ({
				bytes: new TextEncoder().encode("id,email\n1,ada@test"),
				fileName: "users.csv",
			}),
		});
		render(
			<RunCollectionDialog
				collection={withContract(["id", "email"])}
				onOpenChange={vi.fn()}
			/>
		);
		await waitFor(() => expect(screen.getByText("users.csv")).toBeTruthy());

		fireEvent.click(screen.getByRole("button", { name: /remove/i }));

		// Mutation check: drop `onRemove={writer.clear}` and this reds.
		expect(updateCollection.mutate).toHaveBeenCalledWith({
			id: "col_1",
			dataSchema: null,
			dataFile: null,
		});
		expect(screen.getByRole("spinbutton", { name: /iterations/i })).toHaveProperty(
			"value",
			"1"
		);
	});

	it("a refused file leaves the contract alone", async () => {
		render(
			<RunCollectionDialog collection={withContract(["user", "id"])} onOpenChange={vi.fn()} />
		);
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, {
			target: { files: [new File(["user,id\nada"], "ragged.csv")] },
		});
		await waitFor(() => expect(screen.getByText(/Row 1 has 1 value/i)).toBeTruthy());

		// The refusal reaches `onSelect(null)`, as Remove does, with a contract in
		// scope to clear. Mutation check: call `onRemove` from the picker's
		// `refuse()` and this reds.
		expect(updateCollection.mutate).not.toHaveBeenCalled();
	});

	it("names the columns the requests reference that the file lacks", async () => {
		requestsByCollection.set("col_1", [requestBinding("col_1", "email")]);
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		await pickFile("plans.csv", "plan,price\nfree,0");

		// Mutation check: drop the audit from `additionalWarnings` and this reds.
		expect(
			screen.getByText(
				"The requests reference 1 column this file does not carry: email. Every iteration that binds it fails before anything is sent."
			)
		).toBeTruthy();
		// A warning, never a blocker.
		expect(screen.getByRole("button", { name: /^run$/i })).toHaveProperty("disabled", false);
	});

	it("audits every nested collection under Recursive, one with its own contract included", async () => {
		// A run binds one data set to every step it sends, whatever a folder
		// declares - so the audit is the run's subtree, not `collectionsUnderContract`.
		collections.push({
			id: "col_child",
			name: "Child",
			parentId: "col_1",
			elements: [],
			dataSchema: { columns: ["sku"] },
		} as unknown as Collection);
		requestsByCollection.set("col_child", [requestBinding("col_child", "email")]);
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		await pickFile("plans.csv", "plan,price\nfree,0");

		// Not run, so not audited.
		expect(screen.queryByText(/requests reference/i)).toBeNull();

		// Mutation check: audit `collectionsUnderContract` (or the collection
		// alone) and this reds.
		fireEvent.click(screen.getByRole("switch", { name: /include nested collections/i }));
		expect(
			screen.getByText(/requests reference 1 column this file does not carry: email/i)
		).toBeTruthy();
	});

	it("a declare that fails does not block Run", async () => {
		updateCollection.mutate.mockImplementation(() => {
			updateCollection.isError = true;
			updateCollection.error = new Error("The engine is not running.");
		});
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);
		await pickFile("plans.csv", "plan,price\nfree,0");

		expect(screen.getByText(/couldn't update the data contract/i)).toBeTruthy();
		expect(screen.getByText(/the engine is not running/i)).toBeTruthy();

		// Mutation check: gate `canRun` on `writer.isPending || writer.isError` and
		// this reds.
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
		expect(mutate.mock.calls[0][0].scenario.data).toEqual([{ plan: "free", price: "0" }]);
	});
});
