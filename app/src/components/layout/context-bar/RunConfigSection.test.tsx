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
 * What the run was asked to do, in the words the rest of the app uses.
 *
 * The naming cases are the ones with history: `loadTestModeLabel` and
 * `formatConcurrency` exist because the same run was described three different
 * ways depending on the screen (`constant_rps` raw in one header, "workers" in
 * the sidebar, "VUs" in another). Mutation-check: print `config.mode` or a
 * hand-written unit here and those two cases redden.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunConfigSection } from "./RunConfigSection";
import type { Run } from "@/types";

let run: Run | undefined;
let loading = false;

vi.mock("@/queries", () => ({
	useRunQuery: () => ({ data: run, isLoading: loading }),
}));

const TAB = { id: "t1", type: "run", entityId: "run_1" } as const;

const makeRun = (type: Run["type"], configSnapshot: Run["configSnapshot"]): Run => ({
	id: "run_1",
	type,
	status: "completed",
	startTime: 0,
	endTime: 0,
	configSnapshot,
});

beforeEach(() => {
	run = undefined;
	loading = false;
});

describe("RunConfigSection", () => {
	it("names a load run's mode from the shared label list, never the raw token", () => {
		run = makeRun("load", { mode: "constant_rps", duration: "30s", targetRps: 200 });
		render(<RunConfigSection tab={TAB} />);

		expect(screen.getByText("Constant RPS")).toBeInTheDocument();
		expect(screen.queryByText("constant_rps")).not.toBeInTheDocument();
		expect(screen.getByText("30s")).toBeInTheDocument();
		expect(screen.getByText("200")).toBeInTheDocument();
	});

	it("speaks the app's one unit for concurrency", () => {
		run = makeRun("load", { mode: "ramp_up", concurrency: 64, startConcurrency: 8 });
		render(<RunConfigSection tab={TAB} />);

		expect(screen.getByText("64 VUs")).toBeInTheDocument();
		expect(screen.getByText("8 VUs")).toBeInTheDocument();
	});

	it("calls a design run a single send instead of reporting no configuration", () => {
		// A design run's snapshot has no `mode` key - there is no strategy to
		// record for one send - so a mode-only section would read as "nothing
		// was recorded" on every design run there is.
		run = makeRun("design", { method: "GET", url: "https://example.com" });
		render(<RunConfigSection tab={TAB} />);

		expect(screen.getByText("Single send")).toBeInTheDocument();
	});

	it("shows the protocol the run asked for", () => {
		run = makeRun("load", { mode: "iterations", iterations: 50, httpVersion: "http2" });
		render(<RunConfigSection tab={TAB} />);

		expect(screen.getByText("50")).toBeInTheDocument();
		expect(screen.getByText("HTTP/2")).toBeInTheDocument();
	});

	it("leaves out a cap the run did not set", () => {
		run = makeRun("load", { mode: "constant_rps", duration: "10s" });
		render(<RunConfigSection tab={TAB} />);

		expect(screen.queryByText("Target RPS")).not.toBeInTheDocument();
		expect(screen.queryByText("Concurrency")).not.toBeInTheDocument();
		expect(screen.queryByText("Iterations")).not.toBeInTheDocument();
	});

	it("says so when a load run stored no readable configuration", () => {
		run = makeRun("load", undefined);
		render(<RunConfigSection tab={TAB} />);

		expect(screen.getByText("No configuration was recorded for this run")).toBeInTheDocument();
	});

	/*
	 * A collection run's snapshot has none of the load-test keys above - no
	 * mode, no duration, no root-level iterations - so reading it the load way
	 * produced zero rows and the section said "No configuration was recorded"
	 * of a run that recorded a whole plan. Mutation-check: drop the scenario
	 * branch and the first case below reddens on that exact string.
	 */
	it("describes a collection run from its scenario block, not as unrecorded", () => {
		run = makeRun("scenario", {
			scenario: {
				source: "collection",
				collectionId: "col_1",
				recursive: true,
				iterations: 3,
				steps: [
					{ index: 0, name: "Log in" },
					{ index: 1, name: "Check out" },
				],
			},
		});
		render(<RunConfigSection tab={TAB} />);

		expect(
			screen.queryByText("No configuration was recorded for this run")
		).not.toBeInTheDocument();
		expect(screen.getByText("Collection run")).toBeInTheDocument();
		expect(screen.getByText("Steps")).toBeInTheDocument();
		expect(screen.getByText("2")).toBeInTheDocument();
		expect(screen.getByText("3")).toBeInTheDocument();
		expect(screen.getByText("Included")).toBeInTheDocument();
	});

	it("says sub-folders were excluded rather than leaving the row out", () => {
		// Which requests were in the run depends on it, so "no" is an answer,
		// and an absent row would read as neither.
		run = makeRun("scenario", {
			scenario: {
				source: "collection",
				collectionId: "col_1",
				recursive: false,
				iterations: 1,
			},
		});
		render(<RunConfigSection tab={TAB} />);

		expect(screen.getByText("Excluded")).toBeInTheDocument();
	});

	it("does not read a load run as a collection run because a key collided", () => {
		// `type` is what every other surface branches on. A hand-rolled POST
		// /runs body carrying a `scenario` key the engine ignored is still a
		// load run, and must be described as one.
		run = makeRun("load", { mode: "constant_rps", duration: "10s", scenario: { steps: [] } });
		render(<RunConfigSection tab={TAB} />);

		expect(screen.getByText("Constant RPS")).toBeInTheDocument();
		expect(screen.queryByText("Collection run")).not.toBeInTheDocument();
	});

	it("waits rather than declaring the run gone while it is in flight", () => {
		loading = true;
		render(<RunConfigSection tab={TAB} />);

		expect(screen.getByText("Loading…")).toBeInTheDocument();
	});

	it("says the run is gone when it no longer exists", () => {
		render(<RunConfigSection tab={TAB} />);
		expect(screen.getByText("This run is no longer available")).toBeInTheDocument();
	});
});
