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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import RunCollectionDialog from "./RunCollectionDialog";
import { useDashboardStore, useDataFileStore, useSessionStore, useTabsStore } from "@/stores";
import type { Collection } from "@/types";

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

vi.mock("@/queries", () => ({
	useStartScenarioRunMutation: () => startRunState,
	// The picker and the pre-fill both read the caps through `useDataFileLimits`.
	useConfigQuery: () => ({ data: { entries: configEntries } }),
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
	mutate.mockClear();
	startMonitoring.mockClear();
	startLoadMonitoring.mockClear();
	startRunState.isPending = false;
	startRunState.error = null;
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useSessionStore.setState({ activeEnvironmentId: null });
});

describe("the payload", () => {
	it("sends the scenario block with both options and the active environment", () => {
		useSessionStore.setState({ activeEnvironmentId: "env_9" });
		render(<RunCollectionDialog collection={COLLECTION} onOpenChange={vi.fn()} />);

		fireEvent.click(screen.getByRole("switch", { name: /include sub-folders/i }));
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

		expect(screen.getByText(/could not start the run/i)).toBeTruthy();
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

		fireEvent.click(screen.getByRole("switch", { name: /include sub-folders/i }));
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
		});
		// Omitted, not computed: the engine owns "absent means one pass per row".
		expect(mutate.mock.calls[0][0].scenario).not.toHaveProperty("iterations");
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
		}
		fireEvent.change(screen.getByRole("spinbutton", { name: /virtual users/i }), {
			target: { value: "5" },
		});
		fireEvent.change(screen.getByRole("spinbutton", { name: /duration/i }), {
			target: { value: "0" },
		});
		expect(run).toHaveProperty("disabled", true);
		expect(screen.getByText(/greater than zero seconds/i)).toBeTruthy();

		fireEvent.click(run);
		expect(mutate).not.toHaveBeenCalled();
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
		remember("/home/u/users.csv", "users.csv");
		stubReadDataFile(async () => ({
			bytes: bytesOf("user,id\nada,1\ngrace,2"),
			fileName: "users.csv",
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
});
