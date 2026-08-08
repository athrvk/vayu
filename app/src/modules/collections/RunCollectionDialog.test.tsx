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
