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
import type { Collection, Environment, Run } from "@/types";

let run: Run | undefined;
let loading = false;
let requestData: { id: string; name: string } | undefined;
let requestError: unknown;
let environments: Environment[] = [];
let collections: Collection[] = [];

vi.mock("@/queries", async () => {
	const { isRequestNotFound } =
		await vi.importActual<typeof import("@/queries/collections")>("@/queries/collections");
	return {
		useRunQuery: () => ({ data: run, isLoading: loading }),
		useRequestQuery: () => ({ data: requestData, error: requestError }),
		useEnvironmentsQuery: () => ({ data: environments }),
		useCollectionsQuery: () => ({ data: collections }),
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

const collection = (id: string, name: string): Collection => ({ id, name }) as Collection;

/** A collection run, as `GET /runs/:id` returns one - the resolved manifest. */
const scenarioRun = (collectionId: string | null): Run =>
	makeRun({
		type: "scenario",
		requestId: null,
		configSnapshot: {
			scenario: {
				source: "collection",
				...(collectionId ? { collectionId } : {}),
				recursive: false,
				iterations: 1,
				steps: [{ index: 0, requestId: "req_1", name: "Log in" }],
			},
		},
	});

beforeEach(() => {
	run = undefined;
	loading = false;
	requestData = undefined;
	requestError = undefined;
	environments = [];
	collections = [];
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

/*
 * A collection run links no request at all - its source is the folder. Read the
 * request way it reported "Not saved", which is true of the field and says
 * nothing about the run; every case below is about the row naming the thing
 * that actually ran.
 */
describe("RunSourceSection - the collection a scenario run ran", () => {
	it("names the collection instead of reporting an unsaved request", () => {
		collections = [collection("col_1", "Checkout flow")];
		run = scenarioRun("col_1");
		render(<RunSourceSection tab={TAB} />);

		expect(screen.getByRole("button", { name: "Checkout flow" })).toBeInTheDocument();
		expect(screen.queryByText("Not saved")).not.toBeInTheDocument();
		expect(screen.queryByText("Request")).not.toBeInTheDocument();
	});

	it("opens the collection in its own tab, leaving the run tab open", () => {
		collections = [collection("col_1", "Checkout flow")];
		run = scenarioRun("col_1");
		render(<RunSourceSection tab={TAB} />);

		fireEvent.click(screen.getByRole("button", { name: "Checkout flow" }));

		const { openTabs } = useTabsStore.getState();
		expect(openTabs.map((t) => [t.type, t.entityId])).toEqual([["collection", "col_1"]]);
	});

	it("distinguishes a deleted collection from none recorded", () => {
		run = scenarioRun("col_gone");
		render(<RunSourceSection tab={TAB} />);

		expect(screen.getByText("col_gone (deleted)")).toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("still shows the environment the sequence ran against", () => {
		environments = [environment("env_stage", "Staging")];
		collections = [collection("col_1", "Checkout flow")];
		run = { ...scenarioRun("col_1"), environmentId: "env_stage" };
		render(<RunSourceSection tab={TAB} />);

		expect(screen.getByText("Staging")).toBeInTheDocument();
	});

	it("keeps the request row on a load run whose snapshot carries no scenario", () => {
		run = makeRun({ requestId: null });
		render(<RunSourceSection tab={TAB} />);

		expect(screen.getByText("Request")).toBeInTheDocument();
		expect(screen.queryByText("Collection")).not.toBeInTheDocument();
	});
});
