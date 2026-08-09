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
import { useSessionStore, useTabsStore } from "@/stores";
import type { Collection } from "@/types";

const mutate = vi.fn();
const startRunState = {
	mutate,
	isPending: false,
	error: null as Error | null,
};

vi.mock("@/queries", () => ({
	useStartScenarioRunMutation: () => startRunState,
}));

const startMonitoring = vi.fn();
vi.mock("@/services", () => ({
	scenarioRunService: { startMonitoring: (id: string) => startMonitoring(id) },
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
	mutate.mockClear();
	startMonitoring.mockClear();
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
