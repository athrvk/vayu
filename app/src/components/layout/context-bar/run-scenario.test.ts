/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Reading a collection run's plan out of its stored snapshot.
 *
 * The snapshot's `scenario` key arrives as `unknown` - `RunConfigSnapshot` is
 * typed for a load run's flat keys and carries an index signature for the rest -
 * so every case here is about the narrowing holding for input the engine did
 * not write: an older run, a hand-rolled body, a value of the wrong type. The
 * bar must render "nothing recorded" for those, never throw.
 */

import { describe, it, expect } from "vitest";
import { scenarioFromSnapshot } from "./run-scenario";
import type { Run } from "@/types";

const run = (type: Run["type"], configSnapshot: Run["configSnapshot"]): Run =>
	({ id: "run_1", type, status: "completed", startTime: 0, endTime: 0, configSnapshot }) as Run;

const MANIFEST = {
	source: "collection",
	collectionId: "col_1",
	recursive: true,
	iterations: 3,
	dataRowCount: 0,
	steps: [
		{ index: 0, requestId: "req_1", name: "Log in", method: "POST", url: "https://a/login" },
		{ index: 1, requestId: "req_2", name: "Check out", method: "GET", url: "https://a/cart" },
	],
};

describe("scenarioFromSnapshot", () => {
	it("reads the resolved manifest the engine stored", () => {
		const scenario = scenarioFromSnapshot(run("scenario", { scenario: MANIFEST }));

		expect(scenario?.collectionId).toBe("col_1");
		expect(scenario?.iterations).toBe(3);
		expect(scenario?.recursive).toBe(true);
		expect(scenario?.steps).toHaveLength(2);
		expect(scenario?.steps?.[1].name).toBe("Check out");
	});

	it("is null for every run that is not a collection run", () => {
		expect(scenarioFromSnapshot(run("load", { mode: "constant_rps" }))).toBeNull();
		expect(scenarioFromSnapshot(run("design", {}))).toBeNull();
		expect(scenarioFromSnapshot(undefined)).toBeNull();
	});

	it("does not read a load run as one because a key collided", () => {
		// `type` is the discriminator every other surface uses. A raw POST /runs
		// body carrying a `scenario` key the engine ignored is still a load run.
		expect(scenarioFromSnapshot(run("load", { scenario: MANIFEST }))).toBeNull();
	});

	it("is null for a scenario run whose snapshot lost the block", () => {
		expect(scenarioFromSnapshot(run("scenario", {}))).toBeNull();
		expect(scenarioFromSnapshot(run("scenario", undefined))).toBeNull();
		expect(scenarioFromSnapshot(run("scenario", { scenario: "collection" }))).toBeNull();
		expect(scenarioFromSnapshot(run("scenario", { scenario: [] }))).toBeNull();
	});

	it("drops a field of the wrong type rather than passing it through", () => {
		const scenario = scenarioFromSnapshot(
			run("scenario", {
				scenario: {
					collectionId: 7,
					iterations: "3",
					recursive: "yes",
					steps: [{ index: 0, name: "Log in" }, "not a step"],
				},
			})
		);

		expect(scenario).not.toBeNull();
		expect(scenario?.collectionId).toBeUndefined();
		expect(scenario?.iterations).toBeUndefined();
		expect(scenario?.recursive).toBeUndefined();
		// The unreadable entry is dropped, the readable one survives - a plan
		// length that counted junk would be a wrong number on the bar.
		expect(scenario?.steps).toHaveLength(1);
		expect(scenario?.steps?.[0].name).toBe("Log in");
	});

	it("reads the data file's name and hash, and drops a wrong-typed pair (#2051)", () => {
		const hash = "a".repeat(64);
		const named = scenarioFromSnapshot(
			run("scenario", { scenario: { dataFileName: "users.csv", dataFileHash: hash } })
		);
		expect(named?.dataFileName).toBe("users.csv");
		expect(named?.dataFileHash).toBe(hash);
		expect(named?.dataFileCastNumbers).toBe(false);

		// How the run read it (#2540). Mutation check: drop
		// `dataFileCastNumbers` from `scenarioOfSnapshot` and this fails.
		const cast = scenarioFromSnapshot(
			run("scenario", { scenario: { dataFileName: "plans.csv", dataFileCastNumbers: true } })
		);
		expect(cast?.dataFileCastNumbers).toBe(true);

		const junk = scenarioFromSnapshot(
			run("scenario", { scenario: { dataFileName: 7, dataFileHash: {} } })
		);
		expect(junk?.dataFileName).toBeUndefined();
		expect(junk?.dataFileHash).toBeUndefined();

		// The lib's one reader, and its rule: an empty name is no file, and a
		// hash without a name describes nothing. Mutation check: read the block
		// with a local `str` again and both fail.
		const unnamed = scenarioFromSnapshot(
			run("scenario", { scenario: { dataFileName: "", dataFileHash: hash } })
		);
		expect(unnamed?.dataFileName).toBeUndefined();
		expect(unnamed?.dataFileHash).toBeUndefined();
	});

	it("distinguishes no steps recorded from a plan of zero steps", () => {
		// The engine refuses an empty collection with a 400, so a zero-length
		// manifest is not a run that happened - but `undefined` (no key) and
		// `[]` still have to stay apart, or the bar cannot tell "old run" from
		// "this is what ran".
		expect(scenarioFromSnapshot(run("scenario", { scenario: { steps: [] } }))?.steps).toEqual(
			[]
		);
		expect(
			scenarioFromSnapshot(run("scenario", { scenario: { collectionId: "col_1" } }))?.steps
		).toBeUndefined();
	});
});
