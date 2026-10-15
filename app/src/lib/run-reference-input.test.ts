/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A loaded run (`GET /runs/:id`) has no `summary`, so the fields a reference
 * names are read off its `configSnapshot` (#2047). The failure pinned here is
 * the quiet one: a mapper that read `summary` would still produce a line, one
 * naming every loaded run by its kind alone.
 *
 * Mutation check: read `run.summary` alone in `runReferenceInput` and the
 * loaded-run cases redden.
 */

import { describe, it, expect } from "vitest";
import { formatInstant } from "./time-value";
import { loadedRunReference, runReferenceInput } from "./run-reference-input";
import type { Run, RunConfigSnapshot } from "@/types";

const SENTINEL = "s3cr3t-sentinel";
const START = 1_750_000_000_000;
const AT = formatInstant(START, "datetime");

function loadedRun(overrides: Partial<Run> = {}): Run {
	return {
		id: "run_1",
		type: "load",
		status: "completed",
		startTime: START,
		endTime: START + 1000,
		configSnapshot: {
			url: `https://api.example.test/orders?token=${SENTINEL}`,
			method: "POST",
			requestName: "Create order",
			headers: { Authorization: `Bearer ${SENTINEL}` },
			variables: { apiKey: SENTINEL },
			auth: { mode: "bearer", bearer: { token: SENTINEL } },
		},
		...overrides,
	} as Run;
}

describe("runReferenceInput", () => {
	it("reads a loaded run's identity off its snapshot", () => {
		expect(runReferenceInput(loadedRun())).toEqual({
			id: "run_1",
			type: "load",
			status: "completed",
			startTime: START,
			summary: {
				url: `https://api.example.test/orders?token=${SENTINEL}`,
				method: "POST",
				requestName: "Create order",
				scenario: undefined,
			},
		});
	});

	it("reads a list row's summary when there is no snapshot", () => {
		const row = loadedRun({
			configSnapshot: undefined,
			summary: { url: "https://api.example.test/pay", method: "GET", requestName: "Pay" },
		});

		expect(runReferenceInput(row).summary).toMatchObject({
			url: "https://api.example.test/pay",
			method: "GET",
			requestName: "Pay",
		});
	});

	it("keeps a collection run a collection run when its manifest names no collection", () => {
		const run = loadedRun({ type: "scenario", configSnapshot: { scenario: { steps: [] } } });

		expect(runReferenceInput(run).summary?.scenario).toEqual({});
	});

	it("ignores a snapshot field that is not a string", () => {
		// The wire, not the type: the snapshot is stored JSON the engine echoes back.
		const configSnapshot = { url: 42, method: null } as unknown as RunConfigSnapshot;
		const run = loadedRun({ configSnapshot });

		expect(runReferenceInput(run).summary).toMatchObject({ url: undefined, method: undefined });
	});
});

describe("loadedRunReference", () => {
	it("names a loaded run with nothing but its path from the snapshot", () => {
		const line = loadedRunReference(loadedRun(), []);

		expect(line).toBe(
			`Vayu run "Create order" (run_1) - load test, POST /orders, ${AT}, completed`
		);
		expect(line).not.toContain(SENTINEL);
	});

	it("names a collection run by its collection, from the loaded tree", () => {
		const run = loadedRun({
			type: "scenario",
			configSnapshot: { scenario: { collectionId: "col_1", steps: [] } },
		});

		expect(loadedRunReference(run, [{ id: "col_1", name: "Checkout" }])).toBe(
			`Vayu run "Checkout" (run_1) - collection run, collection "Checkout", ${AT}, completed`
		);
	});

	it("falls back to the collection id once that collection is gone", () => {
		const run = loadedRun({
			type: "scenario",
			configSnapshot: { scenario: { collectionId: "col_gone" } },
		});

		expect(loadedRunReference(run, [])).toContain('collection "col_gone"');
	});
});
