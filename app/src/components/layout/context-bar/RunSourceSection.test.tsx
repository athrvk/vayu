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
 * Which environment a run used, and which request it came from.
 *
 * `Run.environmentId` was stored by every send and read by nothing, so a run
 * measured against Staging looked identical to one measured against
 * Production. The case that matters is the first below: the name shown is the
 * run's own environment, not the one that happens to be active now.
 * Mutation-check: read the session store's active environment instead and it
 * reddens.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RunSourceSection } from "./RunSourceSection";
import { useTabsStore } from "@/stores";
import { RequestNotFoundError } from "@/queries/collections";
import type { Environment, Run } from "@/types";

let run: Run | undefined;
let loading = false;
let requestData: { id: string; name: string } | undefined;
let requestError: unknown;
let environments: Environment[] = [];

vi.mock("@/queries", async () => {
	const { isRequestNotFound } =
		await vi.importActual<typeof import("@/queries/collections")>("@/queries/collections");
	return {
		useRunQuery: () => ({ data: run, isLoading: loading }),
		useRequestQuery: () => ({ data: requestData, error: requestError }),
		useEnvironmentsQuery: () => ({ data: environments }),
		isRequestNotFound,
	};
});

const TAB = { id: "t1", type: "run", entityId: "run_1" } as const;

const makeRun = (extra: Partial<Run> = {}): Run => ({
	id: "run_1",
	type: "load",
	status: "completed",
	startTime: 0,
	endTime: 0,
	...extra,
});

const environment = (id: string, name: string): Environment =>
	({ id, name, variables: {} }) as unknown as Environment;

beforeEach(() => {
	run = undefined;
	loading = false;
	requestData = undefined;
	requestError = undefined;
	environments = [];
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});

describe("RunSourceSection - the environment the run used", () => {
	it("names the run's own environment, not whichever one is active now", () => {
		environments = [environment("env_stage", "Staging"), environment("env_prod", "Production")];
		run = makeRun({ environmentId: "env_stage" });
		render(<RunSourceSection tab={TAB} />);

		expect(screen.getByText("Staging")).toBeInTheDocument();
		expect(screen.queryByText("Production")).not.toBeInTheDocument();
	});

	it("says none was active rather than leaving the row blank", () => {
		run = makeRun({ environmentId: null });
		render(<RunSourceSection tab={TAB} />);

		expect(screen.getByText("No environment")).toBeInTheDocument();
	});

	it("distinguishes a deleted environment from none at all", () => {
		// The run kept the id either way, and "No environment" would assert
		// something about the run that is not true.
		run = makeRun({ environmentId: "env_gone" });
		render(<RunSourceSection tab={TAB} />);

		expect(screen.getByText("env_gone (deleted)")).toBeInTheDocument();
	});
});

describe("RunSourceSection - the request it ran from", () => {
	it("opens the request in its own tab, leaving the run tab open", () => {
		run = makeRun({ requestId: "req_1" });
		requestData = { id: "req_1", name: "Create user" };
		render(<RunSourceSection tab={TAB} />);

		fireEvent.click(screen.getByRole("button", { name: "Create user" }));

		const { openTabs } = useTabsStore.getState();
		expect(openTabs.map((t) => [t.type, t.entityId])).toEqual([["request", "req_1"]]);
	});

	it("says the request was deleted instead of offering a tab that cannot open", () => {
		run = makeRun({ requestId: "req_1" });
		requestError = new RequestNotFoundError("req_1");
		render(<RunSourceSection tab={TAB} />);

		expect(screen.getByText("Deleted")).toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("keeps the link for a transport failure, which is not a deletion", () => {
		// `isRequestNotFound` is the discriminator precisely so an unreachable
		// engine does not read as "your request is gone".
		run = makeRun({ requestId: "req_1" });
		requestError = new Error("Failed to fetch");
		render(<RunSourceSection tab={TAB} />);

		expect(screen.queryByText("Deleted")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Open request" })).toBeInTheDocument();
	});

	it("says a run that was never linked to a saved request is not saved", () => {
		run = makeRun({ requestId: null });
		render(<RunSourceSection tab={TAB} />);

		expect(screen.getByText("Not saved")).toBeInTheDocument();
	});

	it("says the run is gone when it no longer exists", () => {
		render(<RunSourceSection tab={TAB} />);
		expect(screen.getByText("This run is no longer available")).toBeInTheDocument();
	});
});
