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
 * Nothing rendered this dialog before, which is how a 450-line component grew a
 * field the engine ignores without anyone noticing. These pin the three things
 * a re-cut could plausibly break: which fields each profile shows, what the
 * payload contains, and that the profile picker is one keyboard control.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	render as renderBare,
	screen,
	fireEvent,
	within,
	cleanup,
	act,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui";
import LoadTestConfigDialog from "./index";
import type { LoadTestConfig } from "@/types";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import { useClientSettingsStore, useDataFileStore } from "@/stores";
import {
	DEFAULT_LOAD_TEST_CEILINGS,
	LOAD_TEST_CEILING_BOUNDS,
	LOAD_TEST_DEFAULTS,
} from "@/constants/load-test";
import { LOAD_TEST_MODES } from "@/constants/load-test-modes";

/**
 * The app mounts one `TooltipProvider` at its root (`main.tsx`), so a panel
 * rendered bare is in a state the app is never in - and since #1690 a gated
 * control inside one carries a real tooltip, which throws without it. Every
 * render in this file goes through the provider, the way the app does.
 */
function render(ui: ReactElement, options?: Parameters<typeof renderBare>[1]) {
	return renderBare(ui, { wrapper: TooltipProvider, ...options });
}

vi.mock("../OAuth2LoadTestGuard", () => ({
	default: () => null,
}));

/**
 * The dialog seeds its scrape cadence and metric cap from the engine's
 * `monitorIntervalMs` / `monitorMaxSeries` settings, so it reads the config
 * query. Mocked rather than wrapped in a provider, the convention the hook
 * tests use - and `configEntries` is mutable so a test can move a setting and
 * assert the dialog followed it.
 */
let configEntries: { key: string; value: string }[] = [];
/**
 * The design and load answers `GET /request-defaults` gives (issue #1338).
 * Separate so a test can make them disagree - the scope argument decides
 * which one a call reads, exactly as `useRequestDefaultsQuery` does for real.
 */
let designHeaders: { name: string; value?: string; generated: boolean }[] = [];
let loadHeaders: { name: string; value?: string; generated: boolean }[] = [];
vi.mock("@/queries", () => ({
	useConfigQuery: () => ({ data: { entries: configEntries } }),
	// The data-file picker's column audit resolves the contract in scope from
	// the collection chain (issue #993); with no collections there is nothing to
	// audit against, which is what every case here wants except the one that
	// declares its own.
	// `elements` filled in because every stored row carries the list, and the
	// requests' audit (issue #2050) scans the chain's scripts out of it.
	useCollectionsQuery: () => ({
		data: collectionRows.map((row) => ({ elements: [], ...row })),
	}),
	// The audit of the one request being load-tested names it explicitly, so
	// nothing is fetched; the hook is still called.
	useMultipleCollectionRequests: () => ({ requestsByCollection: new Map(), isLoading: false }),
	useRequestDefaultsQuery: (scope: "design" | "load" = "design") => ({
		data: { headers: scope === "load" ? loadHeaders : designHeaders },
	}),
}));

/**
 * The contract write a pick or a Remove makes (issue #2050). Mutable, so a case
 * can make it fail.
 */
const updateCollection = {
	mutate: vi.fn(),
	isPending: false,
	isError: false,
	error: null as Error | null,
};
vi.mock("@/queries/collections", () => ({
	useUpdateCollectionMutation: () => updateCollection,
}));

/** Land the last contract write the way TanStack would, running its onSuccess. */
function succeedContractWrite() {
	const calls = updateCollection.mutate.mock.calls;
	const [, options] = calls[calls.length - 1];
	act(() => options?.onSuccess?.({}));
}

/** Collections the contract walk sees. Mutable, like `configEntries` above. */
let collectionRows: {
	id: string;
	name: string;
	parentId?: string;
	dataSchema?: { columns: string[] };
}[] = [];

/*
 * Re-reading the remembered path (issue #1039). Mocked at the service rather
 * than at the hook, so what these cases drive is the real `useDeclaredDataFile`
 * - the one-attempt ref and the declaring-ancestor lookup included - with only
 * the filesystem stubbed out.
 */
const readDeclared = vi.fn();
let bridgePresent = true;
vi.mock("@/services/data-files/read-declared", () => ({
	canReadDeclaredDataFile: () => bridgePresent,
	readDeclaredDataFile: (path: string, options: { maxRows: number }) =>
		readDeclared(path, options),
}));

/**
 * A file as `readDeclaredDataFile` resolves it.
 *
 * Built through one helper rather than spelled out per case so the stub carries
 * every member the picker renders - `format` is the one a hand-written literal
 * forgets, and the picker reads it unguarded.
 */
function declared(fileName: string, rows: Record<string, string>[]) {
	return {
		fileName,
		path: `/data/${fileName}`,
		parsed: {
			format: "csv" as const,
			columns: Object.keys(rows[0] ?? {}),
			rows,
			warnings: [],
		},
	};
}

function open(props: Partial<React.ComponentProps<typeof LoadTestConfigDialog>> = {}) {
	const onStart = vi.fn();
	render(
		<LoadTestConfigDialog
			onClose={vi.fn()}
			onStart={onStart}
			isStarting={false}
			hasPreRequestScript={false}
			hasPostRequestScript={false}
			isStreamingRequest={false}
			{...props}
		/>
	);
	return { onStart };
}

const pickProfile = (name: string) =>
	fireEvent.click(screen.getByRole("radio", { name: new RegExp(name, "i") }));

const started = (onStart: ReturnType<typeof vi.fn>): LoadTestConfig => {
	fireEvent.click(screen.getByRole("button", { name: "Start" }));
	expect(onStart).toHaveBeenCalledTimes(1);
	return onStart.mock.calls[0][0] as LoadTestConfig;
};

beforeEach(() => {
	cleanup();
	localStorage.clear();
	configEntries = [];
	collectionRows = [];
	designHeaders = [];
	loadHeaders = [];
	updateCollection.mutate.mockReset();
	updateCollection.isPending = false;
	updateCollection.isError = false;
	updateCollection.error = null;
	// The ceilings store is module-level and persists across tests in this
	// file; clearing localStorage does not roll it back.
	useClientSettingsStore.getState().setLoadTestCeilings(DEFAULT_LOAD_TEST_CEILINGS);
});

describe("load profile → fields", () => {
	it("shows rate and duration for Constant RPS, and no virtual-user count", () => {
		open();
		expect(screen.getByLabelText(/target rate/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/^duration/i)).toBeInTheDocument();
		expect(screen.queryByLabelText(/^virtual users/i)).not.toBeInTheDocument();
	});

	it("shows virtual users and duration for Constant Virtual Users", () => {
		open();
		pickProfile("Constant Virtual Users");
		expect(screen.getByLabelText(/^virtual users/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/^duration/i)).toBeInTheDocument();
		expect(screen.queryByLabelText(/target rate/i)).not.toBeInTheDocument();
	});

	it("hides Duration entirely for Fixed Iterations", () => {
		// The defect this re-cut exists to fix. The engine stops on
		// `requests_sent < iterations` and never reads duration, so offering the
		// field invites tuning something inert - and it used to persist.
		open();
		pickProfile("Fixed Iterations");
		expect(screen.getByLabelText(/^requests/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/^virtual users/i)).toBeInTheDocument();
		expect(screen.queryByLabelText(/duration/i)).not.toBeInTheDocument();
	});

	it("shows the budget, the step and both bounds for Capacity Discovery", () => {
		open();
		pickProfile("Capacity Discovery");
		expect(screen.getByLabelText(/latency budget/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/hold each level for/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/start from/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/maximum virtual users/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/give up after/i)).toBeInTheDocument();
		// The ramp's own field belongs to the ramp; a search has no ramp curve.
		expect(screen.queryByLabelText(/ramp duration/i)).not.toBeInTheDocument();
	});

	it("shows target, total and ramp for Ramp-Up", () => {
		open();
		pickProfile("Ramp-Up");
		expect(screen.getByLabelText(/target virtual users/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/total duration/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/ramp duration/i)).toBeInTheDocument();
	});
});

describe("payload", () => {
	it("omits duration_seconds for Fixed Iterations", () => {
		const { onStart } = open();
		pickProfile("Fixed Iterations");
		const config = started(onStart);
		expect(config.mode).toBe("iterations");
		expect(config.iterations).toBeGreaterThan(0);
		expect(config).not.toHaveProperty("duration_seconds");
	});

	// `it.each`, not a loop with a manual teardown: the dialog renders through a
	// Radix portal, so removing its node by hand throws and leaves the next
	// iteration asserting against a half-torn-down DOM.
	it.each(["Constant RPS", "Constant Virtual Users", "Ramp-Up", "Capacity Discovery"])(
		"sends duration_seconds for %s",
		(profile) => {
			const { onStart } = open();
			pickProfile(profile);
			expect(started(onStart).duration_seconds).toBeGreaterThan(0);
		}
	);

	it("sends the search bounds and budget for Capacity Discovery", () => {
		const { onStart } = open();
		pickProfile("Capacity Discovery");
		// The default start (1) is below the default ceiling (10), so the
		// picked profile starts valid; anything else and Start is disabled and
		// `started` would fail on the call count rather than on the payload.
		const config = started(onStart);
		expect(config.mode).toBe("capacity");
		// `concurrency` is the ceiling and `start_concurrency` the first level -
		// the ramp's two fields reused, so one Settings cap bounds both modes.
		expect(config.concurrency).toBeGreaterThan(0);
		expect(config.start_concurrency).toBeGreaterThan(0);
		expect(config.slo_ms).toBeGreaterThan(0);
		expect(config.step_duration_seconds).toBeGreaterThan(0);
		// `duration` is the search's deadline in this mode, not a run length.
		expect(config.duration_seconds).toBeGreaterThan(0);
	});

	it("sends no capacity fields for any other profile", () => {
		// The mirror of the test above, and the one that would catch the
		// fields being set unconditionally: a ramp carrying an sloMs would make
		// its stored config claim a search it never ran.
		const { onStart } = open();
		pickProfile("Ramp-Up");
		const config = started(onStart);
		expect(config).not.toHaveProperty("slo_ms");
		expect(config).not.toHaveProperty("step_duration_seconds");
	});

	it("keeps the recording options even though they are folded away", () => {
		const { onStart } = open();
		const config = started(onStart);
		expect(config.success_sample_period).toBeTypeOf("number");
		expect(config.slow_threshold_ms).toBeTypeOf("number");
		expect(config.save_timing_breakdown).toBeTypeOf("boolean");
	});
});

describe("data rows (issue #993)", () => {
	/** Pick @p file through the picker's hidden input, as a user would. */
	const pick = (file: File) => {
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [file] } });
	};

	it("offers a data file, described as a load run binds one", () => {
		open();
		// The load reading - a row per iteration off a cursor every virtual user
		// shares, wrapping when the set runs out - and not design mode's "one
		// iteration per row", which would be wrong for every run this dialog
		// starts.
		expect(screen.getByText(/cursor every virtual user shares/i)).toBeInTheDocument();
		expect(screen.queryByText(/one iteration per row/i)).not.toBeInTheDocument();
	});

	it("sends the parsed rows and their column names on the payload", async () => {
		const { onStart } = open();
		pick(new File(["id\na\nb"], "rows.csv"));
		await screen.findByText(/rows\.csv/);

		const config = started(onStart);
		expect(config.data).toEqual([{ id: "a" }, { id: "b" }]);
		// The names travel with the rows because the run composes before it
		// starts, and composition has to leave a bare `{{id}}` for the per-row
		// bind instead of resolving it from the variable scopes (issue #1007).
		expect(config.dataColumns).toEqual(["id"]);
		// And which file they came from (issue #2051): its name and the SHA-256
		// of its bytes, never its path.
		expect(config.dataFileName).toBe("rows.csv");
		expect(config.dataFileHash).toBe(
			"47084569d953e21c1461d202a7e698a28ff349bd3a5cd6df5230b2f40e3a6f6c"
		);
	});

	// Mutation check: send `dataFile.fileName` unfiltered and this fails.
	it("leaves out a file name holding a path separator, keeping the hash (#2051)", async () => {
		const { onStart } = open();
		pick(new File(["id\na"], "odd\\rows.csv"));
		await screen.findByText(/rows\.csv/);

		const config = started(onStart);
		expect(config.dataFileName).toBeUndefined();
		expect(config.dataFileHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("sends no `data` key at all when no file was picked", () => {
		// Absent rather than `[]`: the engine refuses a present-but-empty array
		// rather than running it, so an empty array would turn "no data set"
		// into a 400.
		const { onStart } = open();
		const config = started(onStart);
		expect(config).not.toHaveProperty("data");
		expect(config).not.toHaveProperty("dataColumns");
		expect(config).not.toHaveProperty("dataFileName");
		expect(config).not.toHaveProperty("dataFileHash");
	});

	it("refuses to start while the picked file cannot be read", async () => {
		const { onStart } = open();
		// A ragged row is one of the parser's own refusals; it leaves no
		// selection behind, so starting would send the request with its
		// `{{data.*}}` tokens written as they stand.
		pick(new File(["id,name\na"], "ragged.csv"));
		await screen.findByText(/couldn.t read the data file/i);

		fireEvent.click(screen.getByRole("button", { name: "Start" }));
		expect(onStart).not.toHaveBeenCalled();
	});

	it("audits the file against the contract the collection chain declares", async () => {
		collectionRows = [{ id: "col_1", name: "Orders", dataSchema: { columns: ["id", "plan"] } }];
		open({ collectionId: "col_1" });
		pick(new File(["id\na"], "rows.csv"));

		// A missing column is a warning here and a loud engine-side failure at
		// bind time - hearing about it before the run is the whole point.
		expect(await screen.findByText(/plan/)).toBeInTheDocument();
	});
});

describe("the declared file pre-fills (issue #1039)", () => {
	const pick = (file: File) => {
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [file] } });
	};

	beforeEach(() => {
		useDataFileStore.setState({ locations: {} });
		readDeclared.mockReset();
		bridgePresent = true;
	});

	it("reads the path remembered for the declaring ancestor, not the request's collection", async () => {
		/*
		 * The #729 rule, and the one a copy of this pre-fill gets wrong: the
		 * request sits in `col_child`, which declares nothing, so the contract -
		 * and therefore the remembered location - belongs to `col_parent`.
		 * Reading the store at the id the caller passed in finds nothing for
		 * exactly the users the chain walk exists to serve.
		 */
		collectionRows = [
			{ id: "col_parent", name: "Orders", dataSchema: { columns: ["id"] } },
			{ id: "col_child", name: "Checkout", parentId: "col_parent" },
		];
		useDataFileStore.setState({
			locations: { col_parent: { path: "/data/users.csv", fileName: "users.csv" } },
		});
		readDeclared.mockResolvedValue(declared("users.csv", [{ id: "a" }]));

		const { onStart } = open({ collectionId: "col_child" });

		expect(await screen.findByText(/users\.csv/)).toBeInTheDocument();
		expect(readDeclared).toHaveBeenCalledWith("/data/users.csv", expect.anything());
		// And it is a real selection, not just a label: the rows reach the run.
		fireEvent.click(screen.getByRole("button", { name: "Start" }));
		expect(onStart.mock.calls[0][0].data).toEqual([{ id: "a" }]);
		// A read of what was declared, not a pick: opening the dialog writes
		// nothing (issue #2050). Mutation check: declare from the pre-fill and
		// this reds.
		expect(updateCollection.mutate).not.toHaveBeenCalled();
	});

	it("shows a note and leaves Start working when the file has moved", async () => {
		collectionRows = [{ id: "col_1", name: "Orders", dataSchema: { columns: ["id"] } }];
		useDataFileStore.setState({
			locations: { col_1: { path: "/gone/users.csv", fileName: "users.csv" } },
		});
		readDeclared.mockRejectedValue(new Error("The declared file is no longer at users.csv."));

		const { onStart } = open({ collectionId: "col_1" });

		expect(await screen.findByText(/no longer at users\.csv/)).toBeInTheDocument();
		// A warning, never a blocker: a load run without rows is an ordinary
		// load run, and picking the file again is the whole remedy.
		fireEvent.click(screen.getByRole("button", { name: "Start" }));
		expect(onStart).toHaveBeenCalled();
		expect(onStart.mock.calls[0][0]).not.toHaveProperty("data");
	});

	it("does not yank a hand-picked file back when the store is written while open", async () => {
		collectionRows = [{ id: "col_1", name: "Orders", dataSchema: { columns: ["id"] } }];
		useDataFileStore.setState({
			locations: { col_1: { path: "/data/first.csv", fileName: "first.csv" } },
		});
		readDeclared.mockResolvedValue(declared("first.csv", [{ id: "a" }]));

		const { onStart } = open({ collectionId: "col_1" });
		await screen.findByText(/first\.csv/);

		pick(new File(["id\nz"], "mine.csv"));
		await screen.findByText(/mine\.csv/);

		// The pre-fill has had its one turn. A store write now - the Data tab
		// in another pane, another dialog - must not replace what the user
		// chose in front of them.
		act(() => {
			useDataFileStore
				.getState()
				.setDataFile("col_1", { path: "/data/second.csv", fileName: "second.csv" });
		});

		expect(screen.getByText(/mine\.csv/)).toBeInTheDocument();
		expect(screen.queryByText(/second\.csv/)).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Start" }));
		expect(onStart.mock.calls[0][0].data).toEqual([{ id: "z" }]);
	});

	it("leaves the profile fields alone", async () => {
		/*
		 * The Run collection dialog turns a pristine `iterations` of 1 into "one
		 * pass per row" when a file arrives. That is a fact about the engine's
		 * default for a *collection* run; a load run's length is its profile's,
		 * so the pre-fill may not touch a single field here.
		 */
		collectionRows = [{ id: "col_1", name: "Orders", dataSchema: { columns: ["id"] } }];
		useDataFileStore.setState({
			locations: { col_1: { path: "/data/users.csv", fileName: "users.csv" } },
		});
		readDeclared.mockResolvedValue(
			declared("users.csv", [{ id: "a" }, { id: "b" }, { id: "c" }])
		);

		const { onStart } = open({ collectionId: "col_1" });
		await screen.findByText(/users\.csv/);

		fireEvent.click(screen.getByRole("button", { name: "Start" }));
		const config = onStart.mock.calls[0][0] as LoadTestConfig;
		expect(config.duration_seconds).toBe(LOAD_TEST_DEFAULTS.DURATION_S);
		expect(config.rps).toBe(LOAD_TEST_DEFAULTS.RPS);
		// Three rows, and not one iteration per row: the default profile is
		// `constant_rps`, whose length is its duration.
		expect(config.iterations).toBeUndefined();
	});

	it("attempts nothing when there is no filesystem to re-read from", async () => {
		// A browser build has no path to re-read and never will, so this is not
		// a failure worth a note - it is a state that will never resolve.
		bridgePresent = false;
		collectionRows = [{ id: "col_1", name: "Orders", dataSchema: { columns: ["id"] } }];
		useDataFileStore.setState({
			locations: { col_1: { path: "/data/users.csv", fileName: "users.csv" } },
		});

		open({ collectionId: "col_1" });

		expect(readDeclared).not.toHaveBeenCalled();
		expect(screen.queryByText(/The remembered data file/i)).not.toBeInTheDocument();
	});
});

describe("stream caps (issue #576)", () => {
	it("shows neither cap for a request that does not stream", () => {
		// Offering bounds on something that is not happening. The flag belongs
		// to the request's Settings tab, and only what this run measures of
		// each stream belongs here.
		open();
		expect(screen.queryByLabelText(/stop each stream after/i)).not.toBeInTheDocument();
		expect(screen.queryByLabelText(/many events/i)).not.toBeInTheDocument();
	});

	it("shows both caps for a streaming request", () => {
		open({ isStreamingRequest: true });
		expect(screen.getByLabelText(/stop each stream after/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/many events/i)).toBeInTheDocument();
	});

	it("sends both caps for a streaming request", () => {
		const { onStart } = open({ isStreamingRequest: true });
		fireEvent.change(screen.getByLabelText(/stop each stream after/i), {
			target: { value: "45" },
		});
		fireEvent.change(screen.getByLabelText(/many events/i), { target: { value: "250" } });
		const config = started(onStart);
		expect(config.stream_duration_seconds).toBe(45);
		expect(config.stream_max_events).toBe(250);
	});

	it("sends the defaults rather than omitting them when the fields are untouched", () => {
		// Omitting would leave the run bounded by the engine's
		// `sseMaxStreamDurationMs`, which this dialog never showed - so the
		// numbers on screen would not be the numbers in force.
		const { onStart } = open({ isStreamingRequest: true });
		const config = started(onStart);
		expect(config.stream_duration_seconds).toBe(LOAD_TEST_DEFAULTS.STREAM_DURATION_S);
		expect(config.stream_max_events).toBe(LOAD_TEST_DEFAULTS.STREAM_MAX_EVENTS);
	});

	it("sends no cap for a non-streaming request", () => {
		// The engine refuses a cap without `stream`, which is what keeps an
		// unbounded run from being mistaken for a capped one - so the dialog
		// must not send one either.
		const { onStart } = open();
		const config = started(onStart);
		expect(config.stream_duration_seconds).toBeUndefined();
		expect(config.stream_max_events).toBeUndefined();
	});
});

describe("notices", () => {
	it("sorts blocking above advisory, since with a stack only order says which blocks", () => {
		open({ hasPreRequestScript: true });
		pickProfile("Ramp-Up");
		// Force the ramp longer than the total.
		fireEvent.change(screen.getByLabelText(/total duration/i), { target: { value: "1" } });

		const alerts = screen.getAllByText(
			/Ramp is longer than the run|Pre-request script won't run/
		);
		expect(alerts).toHaveLength(2);
		expect(alerts[0]).toHaveTextContent("Ramp is longer than the run");
	});

	/*
	 * The dialog used to warn that `{{$guid}}` resolved once and repeated on
	 * every iteration - true when this test last named a prop, false since
	 * issue #995: the load path composes with `deferDynamicVariables`, so the
	 * engine generates a fresh value per iteration instead. Nothing about the
	 * request's own dynamic variables belongs in this dialog any more.
	 */
	it("says nothing about dynamic variables while still rendering its notices", () => {
		// Opened with a notice that *is* still real, so the absence below is
		// this dialog having nothing to say about generators rather than the
		// notice list being empty - an assertion that scanned nothing would
		// pass whatever the callout did.
		open({ hasPreRequestScript: true });
		expect(screen.getByText("Pre-request script won't run")).toBeInTheDocument();
		expect(screen.queryByText(/dynamic variable/i)).toBeNull();
	});

	it("keeps an advisory notice from gating Start", () => {
		open({ hasPreRequestScript: true });
		expect(screen.getByRole("button", { name: "Start" })).not.toBeDisabled();
	});

	// Issue #1594: before the single-request load path ran any element, the
	// warning was unconditional - true at every Scripts setting, since none of
	// them could make a pre-request script reach the wire. `elements.scripts:
	// "allInline"` closes that gap, so this is the one setting where the
	// warning is no longer true.
	it("hides the pre-request warning once Scripts is set to All inline", () => {
		open({ hasPreRequestScript: true });
		expect(screen.getByText("Pre-request script won't run")).toBeInTheDocument();

		fireEvent.click(
			within(screen.getByRole("radiogroup", { name: /^scripts$/i })).getByRole("radio", {
				name: "All inline",
			})
		);

		expect(screen.queryByText("Pre-request script won't run")).toBeNull();
	});

	it("explains the post-request sample for a request with only a post-request script", () => {
		open({ hasPreRequestScript: false, hasPostRequestScript: true });
		expect(screen.getByText("Tests run afterwards, on a sample")).toBeInTheDocument();
		expect(
			screen.getByText(/replayed after the run on about 1 in 100 responses/)
		).toBeInTheDocument();
		expect(screen.queryByText("Pre-request script won't run")).toBeNull();
	});

	it("says nothing about sampling when no post-request script would be replayed", () => {
		open({ hasPostRequestScript: false });
		expect(screen.queryByText("Tests run afterwards, on a sample")).toBeNull();
	});

	it("hides the sampling notice once Scripts is set to All inline", () => {
		open({ hasPostRequestScript: true });
		expect(screen.getByText("Tests run afterwards, on a sample")).toBeInTheDocument();

		fireEvent.click(
			within(screen.getByRole("radiogroup", { name: /^scripts$/i })).getByRole("radio", {
				name: "All inline",
			})
		);

		expect(screen.queryByText("Tests run afterwards, on a sample")).toBeNull();
	});

	it("keeps the sampling notice from gating Start", () => {
		open({ hasPostRequestScript: true });
		expect(screen.getByRole("button", { name: "Start" })).not.toBeDisabled();
	});

	it("describes the test sample in no hint or notice as a percentage of responses", () => {
		// The success-sample slider legitimately reads "10%", so the guard reads
		// the three texts about test sampling rather than the whole dialog.
		open({ hasPostRequestScript: true });
		fireEvent.click(screen.getByRole("button", { name: /recording/i }));

		const texts = [
			/replayed after the run on about 1 in 100 responses/,
			/Post-request tests are sampled separately/,
			/Tests in a post-request script run on a sample/,
		].map((pattern) => screen.getByText(pattern).textContent ?? "");

		for (const text of texts) {
			expect(text.length).toBeGreaterThan(0);
			expect(text).not.toContain("10%");
		}
	});

	it("disables Start while a blocking notice is live", () => {
		open();
		pickProfile("Ramp-Up");
		fireEvent.change(screen.getByLabelText(/total duration/i), { target: { value: "1" } });
		expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
	});
});

/**
 * `elements.scripts` (issue #1594): the same control and the same
 * absent-at-default contract `RunCollectionDialog`'s Scripts toggle has -
 * the engine's own default is "asMarked", so the field is sent only when
 * the user picked something else, and dropped again if they pick "As
 * marked" back.
 */
describe("the Scripts override (issue #1594)", () => {
	const scripts = () => screen.getByRole("radiogroup", { name: /^scripts$/i });

	it("sends no elements override at the default Scripts value", () => {
		const { onStart } = open();
		const config = started(onStart);
		expect(config.elements).toBeUndefined();
	});

	it("sends the override when Scripts is changed", () => {
		const { onStart } = open();
		fireEvent.click(within(scripts()).getByRole("radio", { name: "All inline" }));
		const config = started(onStart);
		expect(config.elements).toEqual({ scripts: "allInline" });
	});

	it("picking As marked back drops the field again", () => {
		const { onStart } = open();
		fireEvent.click(within(scripts()).getByRole("radio", { name: "All deferred" }));
		fireEvent.click(within(scripts()).getByRole("radio", { name: "As marked" }));
		const config = started(onStart);
		expect(config.elements).toBeUndefined();
	});
});

/**
 * The Headers tab renders the design answer, and it is the tab a user reads
 * right before opening this dialog - so with `negotiateCompression: true` and
 * `loadNegotiateCompression: false` the tab shows `Accept-Encoding` for a
 * request whose load run will not send it (issue #1338). These pin that the
 * dialog reads both scopes and says so, and that agreement stays silent.
 */
describe("default headers vs. the Headers tab (issue #1338)", () => {
	it("names the header when the load run's defaults differ from the design tab's", () => {
		designHeaders = [
			{ name: "User-Agent", value: "Vayu/1.0", generated: false },
			{ name: "Accept-Encoding", value: "gzip, br", generated: false },
		];
		loadHeaders = [{ name: "User-Agent", value: "Vayu/1.0", generated: false }];

		open();

		expect(screen.getByText(/Accept-Encoding/)).toBeInTheDocument();
		expect(screen.getByText(/not on this load run/i)).toBeInTheDocument();
	});

	it("says nothing when the two scopes agree", () => {
		designHeaders = [{ name: "Accept-Encoding", value: "gzip, br", generated: false }];
		loadHeaders = [{ name: "Accept-Encoding", value: "gzip, br", generated: false }];

		open();

		expect(screen.queryByText(/Accept-Encoding/)).not.toBeInTheDocument();
		expect(screen.queryByText(/default headers differ/i)).not.toBeInTheDocument();
	});
});

describe("recording & limits is one surface", () => {
	/**
	 * The card used to be worn by the header alone - `bg-card` sat on the
	 * trigger - so opening the disclosure dropped the sample rate, the slow
	 * threshold and the timing switch onto the bare dialog background,
	 * reading as fields unrelated to the row that revealed them.
	 *
	 * The comment field used to live here too, last in this disclosure; it
	 * moved to the top of the dialog body (before "Load profile") so naming a
	 * run is the first thing typed rather than something found behind a
	 * collapsed "Recording & limits" section after the run already started.
	 *
	 * This is keyed on the surface class, not on ancestry, and that is the whole
	 * point: `CollapsibleContent` has always been a child of the `Collapsible`
	 * root, so `trigger.parentElement` contained the fields even while the
	 * layout was broken. Only "the nearest painted surface around the header
	 * also holds the fields" tells the two apart.
	 */
	it("renders the disclosure fields inside the same card as its header", () => {
		open();
		const trigger = screen.getByRole("button", { name: /recording/i });
		fireEvent.click(trigger);

		// `.surface-card`, which declares the card background *and* the `--rule`
		// its inner divider resolves against. It was `.bg-card` before that
		// contract existed; the assertion is unchanged - header and fields share
		// one surface.
		const surface = trigger.closest(".surface-card");
		expect(surface).not.toBeNull();

		for (const label of [
			/success sample rate/i,
			/slow request threshold/i,
			/save timing breakdown/i,
		]) {
			expect(surface).toContainElement(screen.getByLabelText(label));
		}

		// `closest` is ancestor-or-self, and pre-fix it resolved to the trigger,
		// whose siblings the fields were. Stated separately so the loop above is
		// what reports the defect.
		expect(surface).not.toBe(trigger);
	});

	it("keeps the header above its fields in document, and so in tab, order", () => {
		open();
		const trigger = screen.getByRole("button", { name: /recording/i });
		fireEvent.click(trigger);

		const first = screen.getByLabelText(/success sample rate/i);
		const last = screen.getByLabelText(/save timing breakdown/i);
		expect(
			trigger.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		expect(first.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("puts the comment field at the top of the dialog, before Load profile", () => {
		open();
		const comment = screen.getByLabelText(/^comment/i);
		const profileLabel = screen.getByText("Load profile");
		expect(
			comment.compareDocumentPosition(profileLabel) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});

	it("leaves the toggle a real button, so Tab reaches it and Enter/Space fire it", () => {
		open();
		const trigger = screen.getByRole("button", { name: /recording/i });
		expect(trigger.tagName).toBe("BUTTON");
		expect(trigger).not.toHaveAttribute("tabindex", "-1");
		expect(trigger).toHaveAttribute("aria-expanded", "false");

		trigger.focus();
		expect(document.activeElement).toBe(trigger);

		fireEvent.click(trigger);
		expect(trigger).toHaveAttribute("aria-expanded", "true");
	});
});

describe("keyboard", () => {
	it("is a single Tab stop with arrow selection, not four stops", () => {
		open();
		const group = screen.getByRole("radiogroup", { name: /load profile/i });
		const radios = within(group).getAllByRole("radio");
		// One card per entry in LOAD_TEST_MODES - the picker renders from that
		// list, so hardcoding a count here would fail on every mode added.
		expect(radios).toHaveLength(LOAD_TEST_MODES.length);
		expect(radios.filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1);

		radios[0].focus();
		fireEvent.keyDown(group, { key: "ArrowRight" });
		expect(radios[1]).toHaveAttribute("aria-checked", "true");
		expect(document.activeElement).toBe(radios[1]);
	});

	it("wraps at the ends", () => {
		open();
		const group = screen.getByRole("radiogroup", { name: /load profile/i });
		const radios = within(group).getAllByRole("radio");
		radios[0].focus();
		fireEvent.keyDown(group, { key: "ArrowLeft" });
		expect(radios[radios.length - 1]).toHaveAttribute("aria-checked", "true");
	});

	it("labels every field, so none is named by its placeholder alone", () => {
		open();
		fireEvent.click(screen.getByRole("button", { name: /recording/i }));
		for (const label of [
			/target rate/i,
			/^duration/i,
			/slow request threshold/i,
			/^comment/i,
		]) {
			expect(screen.getByLabelText(label)).toBeInTheDocument();
		}
	});
});

describe("ramp start concurrency", () => {
	it("offers a start field, so a ramp no longer always begins at 1", () => {
		// The engine reads `startConcurrency` and defaults it to 1. It was
		// plumbed through the payload, the store and the dashboard's derived
		// report - and nothing ever set it, so every ramp started from 1
		// whatever the user wanted.
		open();
		pickProfile("Ramp-Up");
		expect(screen.getByLabelText(/start from/i)).toBeInTheDocument();
	});

	it("sends it, and only for Ramp-Up", () => {
		const { onStart } = open();
		pickProfile("Ramp-Up");
		fireEvent.change(screen.getByLabelText(/start from/i), { target: { value: "4" } });
		expect(started(onStart).start_concurrency).toBe(4);
	});

	it("omits it for every other profile", () => {
		const { onStart } = open();
		expect(started(onStart)).not.toHaveProperty("start_concurrency");
	});

	it("blocks a start above the target, which would ramp downwards", () => {
		open();
		pickProfile("Ramp-Up");
		fireEvent.change(screen.getByLabelText(/start from/i), { target: { value: "999" } });

		expect(screen.getByText(/Ramp would run downwards/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
	});

	/*
	 * `min={1}` on the input is advisory - a controlled number field still
	 * takes the value, and clearing it reads back as `Number("") === 0`. Until
	 * the floor rule the only feedback was the engine's 400, after Start.
	 */
	it("blocks a start below one virtual user, in both profiles that climb from it", () => {
		open();
		pickProfile("Ramp-Up");
		fireEvent.change(screen.getByLabelText(/start from/i), { target: { value: "0" } });
		expect(screen.getByText(/Start is below one virtual user/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();

		pickProfile("Capacity Discovery");
		fireEvent.change(screen.getByLabelText(/start from/i), { target: { value: "" } });
		expect(screen.getByText(/Start is below one virtual user/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
	});

	it("says where the ramp begins in the summary", () => {
		open();
		pickProfile("Ramp-Up");
		fireEvent.change(screen.getByLabelText(/start from/i), { target: { value: "3" } });
		expect(screen.getByText(/Climbs from 3 to 10 virtual users/i)).toBeInTheDocument();
	});
});

/**
 * The slider is a percentage and the engine's field is a sampling period (keep
 * 1 in N, `counter % N`). Nothing converted between them, so the two ends of
 * the control meant the opposite of what they said: "100% - everything" sent a
 * period of 100 and kept 1%, while the left stop kept every single response.
 * Only the default of 10 was right, 1-in-10 being 10%.
 *
 * Asserted through the payload rather than on `successSamplePeriod` alone,
 * because the unit conversion existing is not the point - it being applied on
 * the way out of this dialog is.
 */
describe("success sample rate reaches the engine in the engine's unit", () => {
	const rateSlider = () => screen.getByLabelText(/success sample rate/i) as HTMLInputElement;
	const openRecording = () => fireEvent.click(screen.getByRole("button", { name: /recording/i }));

	it("sends a period of 1 - every response - at the 100% stop", () => {
		const { onStart } = open();
		openRecording();
		fireEvent.change(rateSlider(), { target: { value: "100" } });
		expect(started(onStart).success_sample_period).toBe(1);
	});

	it("sends a period of 100 - one in a hundred - at the 1% stop", () => {
		const { onStart } = open();
		openRecording();
		fireEvent.change(rateSlider(), { target: { value: "1" } });
		expect(started(onStart).success_sample_period).toBe(100);
	});

	it("leaves the default alone, which is the one value that was already right", () => {
		const { onStart } = open();
		expect(started(onStart).success_sample_period).toBe(10);
	});

	it("never offers, or sends, the divide-by-zero value", () => {
		// The floor used to be 0, and `saved.sampleRate ?? DEFAULT` keeps a
		// stored 0 because 0 is present. A 0 on the wire is `% 0` engine-side.
		localStorage.setItem(STORAGE_KEYS.LAST_LOAD_TEST_CONFIG, JSON.stringify({ sampleRate: 0 }));
		const { onStart } = open();
		openRecording();
		expect(Number(rateSlider().min)).toBeGreaterThanOrEqual(1);
		expect(started(onStart).success_sample_period).toBeGreaterThanOrEqual(1);
	});
});

/**
 * The dialog's ceilings are a user setting, not a constant. Nothing else in the
 * app reads `loadTestCeilings`, so if this dialog stopped resolving them the
 * setting would be written and never read - which is the defect class this
 * codebase repeats most.
 */
describe("ceilings from Settings", () => {
	const virtualUsers = () => screen.getByLabelText(/^virtual users/i) as HTMLInputElement;

	it("offers the raised ceiling on the field it governs", () => {
		useClientSettingsStore.getState().setLoadTestCeilings({ concurrency: 5000 });
		open();
		pickProfile("Constant Virtual Users");
		expect(Number(virtualUsers().max)).toBe(5000);
	});

	it("applies a virtual-user ceiling to the ramp's start too, not just its target", () => {
		// Same physical quantity. A ramp that may only start below 1000 cannot
		// climb to a target of 5000 from anywhere sensible.
		useClientSettingsStore.getState().setLoadTestCeilings({ concurrency: 5000 });
		open();
		pickProfile("Ramp-Up");
		expect(Number((screen.getByLabelText(/start from/i) as HTMLInputElement).max)).toBe(5000);
	});

	it("pulls a restored value back under a ceiling lowered since it was saved", () => {
		localStorage.setItem(
			STORAGE_KEYS.LAST_LOAD_TEST_CONFIG,
			JSON.stringify({ mode: "constant_concurrency", concurrency: 800 })
		);
		useClientSettingsStore.getState().setLoadTestCeilings({ concurrency: 100 });
		const { onStart } = open();
		expect(virtualUsers().value).toBe("100");
		expect(started(onStart).concurrency).toBe(100);
	});

	it("cannot be set past what the engine accepts", () => {
		// The bound is the engine's crash guard, so this clamp is what makes
		// "no setting on that screen can compose a rejected run" true.
		useClientSettingsStore.getState().setLoadTestCeilings({ concurrency: 999_999 });
		open();
		pickProfile("Constant Virtual Users");
		expect(Number(virtualUsers().max)).toBe(LOAD_TEST_CEILING_BOUNDS.concurrency.MAX);
	});
});

/**
 * Budgets are the dialog's only control whose *absence* is meaningful: a run
 * with none is measured and not judged, exactly as every run was before them.
 * These pin both directions, plus the one place the feature reuses a setting
 * the user already has rather than adding a second notion of "too slow".
 */
describe("pass/fail budgets", () => {
	const openBudgets = () =>
		fireEvent.click(screen.getByRole("button", { name: /pass\/fail budgets/i }));
	const p99 = () => screen.getByLabelText(/^p99 latency/i) as HTMLInputElement;

	it("prefills the p99 budget from the capacity SLO rather than inventing a default", () => {
		// `sloThresholdMs` existed as a chart annotation and never reached the
		// engine. If this stopped reading it the setting would be written and
		// never read - the defect class this codebase repeats most.
		useClientSettingsStore.getState().setSloThresholdMs(345);
		const { onStart } = open();
		openBudgets();
		expect(p99().value).toBe("345");
		expect(started(onStart).thresholds).toEqual({ latencyP99Ms: 345 });
	});

	it("sends no thresholds at all once every budget is cleared", () => {
		const { onStart } = open();
		openBudgets();
		fireEvent.change(p99(), { target: { value: "" } });
		// Not `{}`: POST /runs rejects an empty object rather than starting a
		// run nothing will judge, so the key has to be absent.
		expect(started(onStart).thresholds).toBeUndefined();
	});

	it("sends every declared budget under the engine's own key", () => {
		const { onStart } = open();
		openBudgets();
		fireEvent.change(p99(), { target: { value: "50" } });
		fireEvent.change(screen.getByLabelText(/error rate/i), { target: { value: "0.1" } });
		fireEvent.change(screen.getByLabelText(/throughput/i), { target: { value: "1000" } });
		expect(started(onStart).thresholds).toEqual({
			latencyP99Ms: 50,
			maxErrorRatePct: 0.1,
			minThroughputRps: 1000,
		});
	});

	it("blocks Start on an out-of-range budget instead of dropping the field", () => {
		const { onStart } = open();
		openBudgets();
		fireEvent.change(screen.getByLabelText(/error rate/i), { target: { value: "150" } });
		fireEvent.click(screen.getByRole("button", { name: "Start" }));
		expect(onStart).not.toHaveBeenCalled();
		expect(screen.getByText(/budget is out of range/i)).toBeInTheDocument();
	});

	/*
	 * `custom.<name>.<stat>` rows (issue #1579). The rules are `budgets.ts`'s
	 * and are tested there; these pin the wiring - that a row the user adds
	 * reaches the payload under the engine's own key, and that a half-filled one
	 * stops the run here rather than at the engine's 400.
	 */
	const addCustomRow = () =>
		fireEvent.click(screen.getByRole("button", { name: /add custom metric budget/i }));

	it("sends a custom metric budget under the engine's own key", () => {
		const { onStart } = open();
		openBudgets();
		fireEvent.change(p99(), { target: { value: "" } });
		addCustomRow();
		fireEvent.change(screen.getByLabelText(/custom budget 1 metric name/i), {
			target: { value: "checkout_ttfb" },
		});
		fireEvent.change(screen.getByLabelText(/custom budget 1 ceiling/i), {
			target: { value: "120" },
		});

		expect(started(onStart).thresholds).toEqual({ "custom.checkout_ttfb.p50": 120 });
	});

	it("blocks Start on a half-filled custom row instead of dropping it", () => {
		const { onStart } = open();
		openBudgets();
		addCustomRow();
		fireEvent.change(screen.getByLabelText(/custom budget 1 ceiling/i), {
			target: { value: "120" },
		});

		fireEvent.click(screen.getByRole("button", { name: "Start" }));
		expect(onStart).not.toHaveBeenCalled();
		expect(screen.getByText(/budget is out of range/i)).toBeInTheDocument();
	});

	it("drops a removed row rather than remembering what it held", () => {
		const { onStart } = open();
		openBudgets();
		fireEvent.change(p99(), { target: { value: "" } });
		addCustomRow();
		fireEvent.change(screen.getByLabelText(/custom budget 1 metric name/i), {
			target: { value: "checkout_ttfb" },
		});
		fireEvent.change(screen.getByLabelText(/custom budget 1 ceiling/i), {
			target: { value: "120" },
		});
		fireEvent.click(screen.getByRole("button", { name: /remove custom budget 1/i }));

		expect(started(onStart).thresholds).toBeUndefined();
	});

	it("keeps a cleared budget cleared across dialog opens", () => {
		// The prefill seeds a first run only. Re-seeding from the setting every
		// time would undo the user's decision to run without a latency budget,
		// silently, on the next run.
		useClientSettingsStore.getState().setSloThresholdMs(200);
		const first = open();
		openBudgets();
		fireEvent.change(p99(), { target: { value: "" } });
		expect(started(first.onStart).thresholds).toBeUndefined();

		cleanup();
		const second = open();
		openBudgets();
		expect(p99().value).toBe("");
		expect(started(second.onStart).thresholds).toBeUndefined();
	});

	/*
	 * What the closed card and the notice stack say about the budgets that will
	 * judge the run (issue #2194). The wording rules are `budgets.ts`'s and
	 * `carried-budgets.ts`'s; these pin that the dialog shows them.
	 */
	describe("what is active and what was carried over (#2194)", () => {
		const seedMemo = (memo: Record<string, unknown>) =>
			localStorage.setItem(STORAGE_KEYS.LAST_LOAD_TEST_CONFIG, JSON.stringify(memo));
		const trigger = () => screen.getByRole("button", { name: /pass\/fail budgets/i });
		const clearCarriedButton = () =>
			screen.queryByRole("button", { name: "Clear carried-over budgets" });
		const carriedNotice = () => screen.queryByText(/budgets (carried over|prefilled)/i);

		it("names the seeded p99 on the closed card", () => {
			// Mutation check: drop the `summary` prop from BudgetsSection and this
			// reds - the card is silent again.
			useClientSettingsStore.getState().setSloThresholdMs(200);
			open();
			expect(trigger()).toHaveTextContent("1 budget active - p99 latency at most 200 ms");
		});

		it("counts several budgets and says none once they are cleared", () => {
			seedMemo({ budgets: { latencyP99Ms: "100", maxErrorRatePct: "1" } });
			open();
			expect(trigger()).toHaveTextContent("2 budgets active");

			openBudgets();
			fireEvent.change(p99(), { target: { value: "" } });
			fireEvent.change(screen.getByLabelText(/error rate at most/i), {
				target: { value: "" },
			});
			expect(trigger()).toHaveTextContent("No budgets");
		});

		it("counts a custom row alongside the fixed fields", () => {
			seedMemo({
				budgets: { latencyP99Ms: "" },
				customBudgets: [{ id: "c1", name: "cart", stat: "p95", value: "5" }],
			});
			open();
			expect(trigger()).toHaveTextContent("1 budget active - custom.cart.p95 at most 5");
		});

		it("keeps the summary on the card while it is open", () => {
			open();
			openBudgets();
			expect(trigger()).toHaveTextContent("1 budget active");
		});

		it("explains the card without leaning on a history the user may not have", () => {
			open();
			openBudgets();
			expect(
				screen.getByText(/with every field blank the run is measured but not judged/i)
			).toBeInTheDocument();
			expect(screen.queryByText(/as before/i)).not.toBeInTheDocument();
			expect(
				screen.getByText(/Starts from Settings > Dashboard > SLO threshold/)
			).toBeInTheDocument();
		});

		it("names the request whose Start set the carried budgets", () => {
			seedMemo({
				budgets: { latencyP99Ms: "150", maxErrorRatePct: "2" },
				budgetsFrom: { requestName: "Orders" },
			});
			open();
			expect(carriedNotice()).toHaveTextContent(
				'Budgets carried over from "Orders": p99 latency at most 150 ms, Error rate at most 2%. They will judge this run.'
			);
		});

		it("falls back to the last load test for a memo that predates the origin", () => {
			seedMemo({ budgets: { latencyP99Ms: "150" } });
			open();
			expect(carriedNotice()).toHaveTextContent("carried over from your last load test");
		});

		it("says a first-run p99 came from the SLO setting rather than from a past run", () => {
			useClientSettingsStore.getState().setSloThresholdMs(200);
			open();
			expect(carriedNotice()).toHaveTextContent(
				"Budgets prefilled: p99 latency at most 200 ms (from Settings > Dashboard > SLO threshold). They will judge this run."
			);
			expect(carriedNotice()).not.toHaveTextContent(/last load test/);
		});

		it("clears exactly the carried budgets and sends no thresholds", () => {
			seedMemo({
				budgets: { latencyP99Ms: "150", maxErrorRatePct: "2" },
				budgetsFrom: { requestName: "Orders" },
			});
			const { onStart } = open();
			// A budget the user adds on top is theirs and must survive the clear.
			openBudgets();
			fireEvent.change(screen.getByLabelText(/throughput/i), { target: { value: "500" } });

			fireEvent.click(clearCarriedButton()!);

			expect(p99().value).toBe("");
			expect(screen.getByLabelText(/error rate at most/i)).toHaveValue(null);
			expect(screen.getByLabelText(/throughput/i)).toHaveValue(500);
			expect(carriedNotice()).not.toBeInTheDocument();
			expect(started(onStart).thresholds).toEqual({ minThroughputRps: 500 });
		});

		it("clears a carried custom row and keeps one added since", () => {
			seedMemo({
				budgets: { latencyP99Ms: "" },
				customBudgets: [{ id: "c1", name: "cart", stat: "p95", value: "5" }],
			});
			const { onStart } = open();
			openBudgets();
			addCustomRow();
			fireEvent.change(screen.getByLabelText(/custom budget 2 metric name/i), {
				target: { value: "mine" },
			});
			fireEvent.change(screen.getByLabelText(/custom budget 2 ceiling/i), {
				target: { value: "9" },
			});

			fireEvent.click(clearCarriedButton()!);

			expect(started(onStart).thresholds).toEqual({ "custom.mine.p50": 9 });
		});

		it("stops claiming a budget once the user edits it", () => {
			seedMemo({ budgets: { latencyP99Ms: "150" }, budgetsFrom: { requestName: "Orders" } });
			open();
			openBudgets();
			fireEvent.change(p99(), { target: { value: "90" } });
			expect(carriedNotice()).not.toBeInTheDocument();
		});

		it("says nothing about a budget the memo recorded as cleared", () => {
			seedMemo({ budgets: { latencyP99Ms: "" } });
			open();
			expect(carriedNotice()).not.toBeInTheDocument();
		});

		it("attributes the budgets to this request on a Start that changed them", () => {
			seedMemo({ budgets: { latencyP99Ms: "150" }, budgetsFrom: { requestName: "Orders" } });
			const { onStart } = open({
				referenceOwner: { type: "request", request: { id: "req_9", name: "Invoices" } },
			});
			openBudgets();
			fireEvent.change(p99(), { target: { value: "90" } });
			started(onStart);

			cleanup();
			open();
			expect(carriedNotice()).toHaveTextContent('carried over from "Invoices"');
		});

		it("keeps naming the original request when a Start leaves the budgets alone", () => {
			seedMemo({ budgets: { latencyP99Ms: "150" }, budgetsFrom: { requestName: "Orders" } });
			const { onStart } = open({
				referenceOwner: { type: "request", request: { id: "req_9", name: "Invoices" } },
			});
			started(onStart);

			cleanup();
			open();
			expect(carriedNotice()).toHaveTextContent('carried over from "Orders"');
		});

		it("falls back to the last load test when the changing Start had no saved request", () => {
			seedMemo({ budgets: { latencyP99Ms: "150" }, budgetsFrom: { requestName: "Orders" } });
			const { onStart } = open();
			openBudgets();
			fireEvent.change(p99(), { target: { value: "90" } });
			started(onStart);

			cleanup();
			open();
			expect(carriedNotice()).toHaveTextContent("carried over from your last load test");
		});

		/*
		 * The same set the notice names rides to the engine as `carriedBudgets`
		 * (issue #2195), so the stored report can tag those checks.
		 */
		describe("what Start sends as carried (#2195)", () => {
			it("sends the memo's budgets under their thresholds keys", () => {
				// Mutation check: drop `carriedBudgets` from the draft handed to
				// buildLoadTestConfig and every case here reds.
				seedMemo({ budgets: { latencyP99Ms: "150", maxErrorRatePct: "2" } });
				const { onStart } = open();
				const config = started(onStart);
				expect(config.carriedBudgets).toEqual(["latencyP99Ms", "maxErrorRatePct"]);
				expect(config.thresholds).toEqual({ latencyP99Ms: 150, maxErrorRatePct: 2 });
			});

			it("includes the p99 the SLO setting seeded", () => {
				useClientSettingsStore.getState().setSloThresholdMs(200);
				const { onStart } = open();
				expect(started(onStart).carriedBudgets).toEqual(["latencyP99Ms"]);
			});

			it("drops a carried budget the user edits, keeping the untouched ones", () => {
				seedMemo({ budgets: { latencyP99Ms: "150", maxErrorRatePct: "2" } });
				const { onStart } = open();
				openBudgets();
				fireEvent.change(p99(), { target: { value: "90" } });
				const config = started(onStart);
				expect(config.carriedBudgets).toEqual(["maxErrorRatePct"]);
				expect(config.thresholds).toEqual({ latencyP99Ms: 90, maxErrorRatePct: 2 });
			});

			it("omits the key when the only budget was typed this time", () => {
				const { onStart } = open();
				openBudgets();
				fireEvent.change(p99(), { target: { value: "90" } });
				const config = started(onStart);
				expect(config.thresholds).toEqual({ latencyP99Ms: 90 });
				expect(config).not.toHaveProperty("carriedBudgets");
			});

			it("omits the key when the carried budgets were cleared", () => {
				seedMemo({ budgets: { latencyP99Ms: "150", maxErrorRatePct: "2" } });
				const { onStart } = open();
				openBudgets();
				fireEvent.change(screen.getByLabelText(/throughput/i), {
					target: { value: "500" },
				});
				fireEvent.click(clearCarriedButton()!);
				const config = started(onStart);
				expect(config.thresholds).toEqual({ minThroughputRps: 500 });
				expect(config).not.toHaveProperty("carriedBudgets");
			});

			it("sends a carried custom row as custom.<name>.<stat>, trimmed", () => {
				seedMemo({
					budgets: { latencyP99Ms: "" },
					customBudgets: [{ id: "c1", name: " cart ", stat: "p95", value: "5" }],
				});
				const { onStart } = open();
				const config = started(onStart);
				expect(config.carriedBudgets).toEqual(["custom.cart.p95"]);
				expect(config.thresholds).toEqual({ "custom.cart.p95": 5 });
			});

			it("does not claim a custom row the user added beside a carried one", () => {
				seedMemo({
					budgets: { latencyP99Ms: "" },
					customBudgets: [{ id: "c1", name: "cart", stat: "p95", value: "5" }],
				});
				const { onStart } = open();
				openBudgets();
				addCustomRow();
				fireEvent.change(screen.getByLabelText(/custom budget 2 metric name/i), {
					target: { value: "mine" },
				});
				fireEvent.change(screen.getByLabelText(/custom budget 2 ceiling/i), {
					target: { value: "9" },
				});
				expect(started(onStart).carriedBudgets).toEqual(["custom.cart.p95"]);
			});
		});
	});

	it("hands the saved request to each budget's Copy for agent (#2047)", () => {
		open({ referenceOwner: { type: "request", request: { id: "req_7", name: "Orders" } } });
		openBudgets();

		// Mutation check: stop forwarding `referenceOwner` to BudgetsSection and
		// the fixed fields lose their button.
		expect(
			screen.getByRole("button", { name: "Copy p99 latency at most for agent" })
		).toBeInTheDocument();
	});

	it("has no Copy for agent without a saved request", () => {
		open();
		openBudgets();

		expect(screen.getByLabelText(/p99 latency/i)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /for agent$/ })).not.toBeInTheDocument();
	});
});

/**
 * Server monitoring: the run's optional second data source. The rules live in
 * `monitor.ts` and are tested there; these pin the wiring - that what the user
 * types reaches the payload, that an incomplete block stops the run here rather
 * than at the engine's 400, and that a run without one is unchanged.
 */
describe("server monitoring", () => {
	const openMonitoring = () =>
		fireEvent.click(screen.getByRole("button", { name: /server monitoring/i }));
	const url = () => screen.getByLabelText(/metrics endpoint/i) as HTMLInputElement;
	const metrics = () => screen.getByLabelText(/metrics to chart/i) as HTMLTextAreaElement;

	it("sends nothing when no endpoint is given", () => {
		const { onStart } = open();
		expect(started(onStart).monitor).toBeUndefined();
	});

	it("sends the block the user typed", () => {
		const { onStart } = open();
		openMonitoring();
		fireEvent.change(url(), { target: { value: "http://localhost:9100/metrics" } });
		fireEvent.change(metrics(), {
			target: { value: "node_cpu_seconds_total\nprocess_resident_memory_bytes" },
		});

		expect(started(onStart).monitor).toEqual({
			url: "http://localhost:9100/metrics",
			intervalMs: 1000,
			format: "prometheus",
			series: ["node_cpu_seconds_total", "process_resident_memory_bytes"],
		});
	});

	it("blocks Start on an endpoint with no metrics instead of dropping the block", () => {
		// The engine rejects `series: []`, so a silently dropped block would be a
		// run the user believes is monitored and a chart that never appears.
		const { onStart } = open();
		openMonitoring();
		fireEvent.change(url(), { target: { value: "http://localhost:9100/metrics" } });
		fireEvent.click(screen.getByRole("button", { name: "Start" }));

		expect(onStart).not.toHaveBeenCalled();
		expect(screen.getByText(/server monitoring is incomplete/i)).toBeInTheDocument();
	});

	it("seeds the interval from the engine setting rather than its own number", () => {
		// `monitorIntervalMs` would otherwise be a setting with no reader on this
		// path: the dialog always sends an explicit interval, so a hardcoded
		// default here means the engine's copy never applies to a run started
		// from the app.
		configEntries = [{ key: "monitorIntervalMs", value: "5000" }];
		const { onStart } = open();
		openMonitoring();
		fireEvent.change(url(), { target: { value: "http://localhost:9100/metrics" } });
		fireEvent.change(metrics(), { target: { value: "up" } });

		expect(started(onStart).monitor?.intervalMs).toBe(5000);
	});

	it("accepts as many metrics as the engine setting allows", () => {
		// The cap is `monitorMaxSeries`; a dialog holding its own 8 would refuse a
		// list the engine was just configured to accept.
		configEntries = [{ key: "monitorMaxSeries", value: "12" }];
		const { onStart } = open();
		openMonitoring();
		fireEvent.change(url(), { target: { value: "http://localhost:9100/metrics" } });
		fireEvent.change(metrics(), {
			target: { value: Array.from({ length: 10 }, (_, i) => `m${i}`).join("\n") },
		});

		expect(started(onStart).monitor?.series).toHaveLength(10);
	});

	it("blocks Start past the configured cap", () => {
		configEntries = [{ key: "monitorMaxSeries", value: "2" }];
		const { onStart } = open();
		openMonitoring();
		fireEvent.change(url(), { target: { value: "http://localhost:9100/metrics" } });
		fireEvent.change(metrics(), { target: { value: "a\nb\nc" } });
		fireEvent.click(screen.getByRole("button", { name: "Start" }));

		expect(onStart).not.toHaveBeenCalled();
		expect(screen.getByText(/at most 2 metrics/i)).toBeInTheDocument();
	});

	it("remembers the endpoint across dialog opens - it is a property of the target", () => {
		const first = open();
		openMonitoring();
		fireEvent.change(url(), { target: { value: "http://localhost:9100/metrics" } });
		fireEvent.change(metrics(), { target: { value: "up" } });
		expect(started(first.onStart).monitor?.series).toEqual(["up"]);

		cleanup();
		open();
		openMonitoring();
		expect(url().value).toBe("http://localhost:9100/metrics");
		expect(metrics().value).toBe("up");
	});
});

/**
 * A memo written by an older build predates whatever field `BudgetDraft` or
 * `MonitorDraft` gained since - `maxAssertionFailureRatePct` did not always
 * exist. `budgetError`/`monitorError` read every field of their draft
 * unconditionally, so restoring that stale shape wholesale (rather than
 * merged onto the empty draft) crashed the dialog outright on open with
 * "Cannot read properties of undefined (reading 'trim')", before a user ever
 * got to see a field, let alone a validation message.
 */
describe("a saved config missing a field a newer build added", () => {
	it("opens without crashing when a saved budget predates a field", () => {
		localStorage.setItem(
			STORAGE_KEYS.LAST_LOAD_TEST_CONFIG,
			JSON.stringify({
				budgets: {
					latencyP50Ms: "",
					latencyP95Ms: "",
					latencyP99Ms: "500",
					maxErrorRatePct: "",
					minThroughputRps: "",
					// `maxAssertionFailureRatePct` intentionally absent.
				},
			})
		);
		expect(() => open()).not.toThrow();
		expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
	});

	it("opens without crashing when a saved monitor block predates a field", () => {
		localStorage.setItem(
			STORAGE_KEYS.LAST_LOAD_TEST_CONFIG,
			JSON.stringify({ monitor: { url: "http://localhost:9100/metrics" } })
		);
		expect(() => open()).not.toThrow();
		expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
	});

	it("still keeps every value the stale budget did carry", () => {
		localStorage.setItem(
			STORAGE_KEYS.LAST_LOAD_TEST_CONFIG,
			JSON.stringify({
				budgets: {
					latencyP50Ms: "",
					latencyP95Ms: "",
					latencyP99Ms: "500",
					maxErrorRatePct: "2",
					minThroughputRps: "",
				},
			})
		);
		open();
		fireEvent.click(screen.getByRole("button", { name: /pass\/fail budgets/i }));
		expect(screen.getByLabelText(/p99 latency at most/i)).toHaveValue(500);
		expect(screen.getByLabelText(/error rate at most/i)).toHaveValue(2);
	});
});

/*
 * A pick in this dialog declares the contract from the picked file (issue
 * #2050), the same rule as the Run collection dialog and the Data tab: for the
 * collection whose contract the request binds against, Remove clearing it, a
 * refused file touching nothing and the pre-fill writing nothing.
 */
describe("a pick declares the contract (issue #2050)", () => {
	const pick = async (name: string, text: string) => {
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [new File([text], name)] } });
		await screen.findByText(name);
	};

	/** The request being load-tested, binding `{{data.<column>}}` in its URL. */
	const requestBinding = (column: string) => ({
		url: `https://api.test/users/{{data.${column}}}`,
		params: [],
		headers: [],
		body: { mode: "none" as const },
		elements: [],
		auth: { mode: "none" as const },
	});

	beforeEach(() => {
		useDataFileStore.setState({ locations: {} });
		readDeclared.mockReset();
		bridgePresent = true;
		vi.stubGlobal("electronAPI", { getFilePath: () => "/home/u/plans.csv" });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("picking a file declares its columns for the request's collection", async () => {
		open({ collectionId: "col_1" });
		await pick("plans.csv", "plan,price\nfree,0");

		// Mutation check: drop `writer.declare(next)` from the handler and this reds.
		expect(updateCollection.mutate).toHaveBeenCalledWith(
			{
				id: "col_1",
				dataSchema: {
					columns: ["plan", "price"],
					fileName: "plans.csv",
					declaredAt: expect.any(Number),
				},
			},
			expect.anything()
		);
		succeedContractWrite();
		expect(useDataFileStore.getState().locations.col_1?.path).toBe("/home/u/plans.csv");
	});

	it("declares for the ancestor that holds the contract", async () => {
		collectionRows = [
			{ id: "col_p", name: "Orders", dataSchema: { columns: ["id"] } },
			{ id: "col_1", name: "Checkout", parentId: "col_p" },
		];
		open({ collectionId: "col_1" });
		await pick("plans.csv", "plan,price\nfree,0");

		// Mutation check: declare against the `collectionId` prop instead of
		// `declaringCollectionId` and this reds.
		expect(updateCollection.mutate).toHaveBeenCalledWith(
			expect.objectContaining({ id: "col_p" }),
			expect.anything()
		);
	});

	it("Remove clears the contract, forgets the path and sends no rows", async () => {
		collectionRows = [
			{ id: "col_1", name: "Orders", dataSchema: { columns: ["id", "email"] } },
		];
		useDataFileStore.setState({
			locations: { col_1: { path: "/data/users.csv", fileName: "users.csv" } },
		});
		readDeclared.mockResolvedValue(declared("users.csv", [{ id: "1", email: "ada@test" }]));
		const { onStart } = open({ collectionId: "col_1" });
		await screen.findByText(/users\.csv/);

		fireEvent.click(screen.getByRole("button", { name: /remove/i }));

		// Mutation check: drop `onRemove={writer.clear}` and this reds.
		expect(updateCollection.mutate).toHaveBeenCalledWith(
			{ id: "col_1", dataSchema: null },
			expect.anything()
		);
		succeedContractWrite();
		expect(useDataFileStore.getState().locations.col_1).toBeUndefined();
		expect(started(onStart)).not.toHaveProperty("data");
	});

	it("a refused file leaves the contract alone", async () => {
		collectionRows = [{ id: "col_1", name: "Orders", dataSchema: { columns: ["id", "name"] } }];
		open({ collectionId: "col_1" });
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [new File(["id,name\na"], "ragged.csv")] } });
		await screen.findByText(/couldn.t read the data file/i);

		// The refusal reaches `onSelect(null)`, as Remove does, with a contract in
		// scope to clear. Mutation check: call `onRemove` from the picker's
		// `refuse()` and this reds.
		expect(updateCollection.mutate).not.toHaveBeenCalled();
	});

	it("names the columns the request references that the file lacks", async () => {
		const { onStart } = open({ collectionId: "col_1", request: requestBinding("email") });
		await pick("plans.csv", "plan,price\nfree,0");

		// Mutation check: drop the audit from `additionalWarnings` and this reds.
		expect(
			screen.getByText(
				"The requests reference 1 column this file does not carry: email. Every iteration that binds it fails before anything is sent."
			)
		).toBeInTheDocument();
		// A warning, never a blocker.
		expect(started(onStart).data).toEqual([{ plan: "free", price: "0" }]);
	});

	it("a declare that fails does not block Start", async () => {
		updateCollection.mutate.mockImplementation(() => {
			updateCollection.isError = true;
			updateCollection.error = new Error("The engine is not running.");
		});
		const { onStart } = open({ collectionId: "col_1" });
		await pick("plans.csv", "plan,price\nfree,0");

		expect(screen.getByText(/couldn't update the data contract/i)).toBeInTheDocument();
		expect(screen.getByText(/the engine is not running/i)).toBeInTheDocument();
		// Mutation check: gate Start on `writer.isPending || writer.isError` and
		// this reds.
		expect(started(onStart).data).toEqual([{ plan: "free", price: "0" }]);
	});

	it("a request in no collection declares nothing", async () => {
		const { onStart } = open({ request: requestBinding("email") });
		await pick("plans.csv", "plan,price\nfree,0");

		// Mutation check: drop the writer's no-collection guard and the update is
		// sent with an empty id; this reds.
		expect(updateCollection.mutate).not.toHaveBeenCalled();
		expect(started(onStart).data).toEqual([{ plan: "free", price: "0" }]);
		// The audit still runs: a request in no collection binds rows all the same.
		expect(screen.getByText(/requests reference 1 column/i)).toBeInTheDocument();
	});
});
