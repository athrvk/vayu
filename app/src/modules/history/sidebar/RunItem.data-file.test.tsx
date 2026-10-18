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
 * A history row's time card names the data file that drove the run (#2051).
 *
 * The list row carries a compact summary, and the engine puts the pair in two
 * places: top level for a load run, inside `summary.scenario` for a collection
 * run. The card reads both, and never the hash.
 *
 * Mutation check: drop the `Data file` push from `RunItem` and the two named
 * cases fail; read only `summary.dataFileName` and the collection-run case fails.
 */

import { describe, it, expect } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import RunItem from "./RunItem";
import type { Run } from "@/types";

const HASH = "a".repeat(64);

function run(summary: Run["summary"], type: Run["type"] = "load"): Run {
	return {
		id: "run_1",
		type,
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_003_000,
		requestId: "req_1",
		environmentId: null,
		summary,
	} as Run;
}

async function openCard(r: Run): Promise<string> {
	render(<RunItem run={r} onSelect={() => {}} onDelete={() => {}} isDeleting={false} />);
	fireEvent.focus(screen.getByRole("button", { name: /^Open .*, completed/ }));
	return (await screen.findByTestId("time-hover-card")).textContent ?? "";
}

describe("the history row's data file", () => {
	it("names a load run's file from the summary's top level", async () => {
		const card = await openCard(
			run({
				url: "https://api.example.test",
				method: "GET",
				dataFileName: "users.csv",
				dataFileHash: HASH,
			})
		);
		expect(card).toContain("Data fileusers.csv");
		expect(card).not.toContain(HASH);
	});

	it("names a collection run's file from the summary's scenario block", async () => {
		const card = await openCard(
			run(
				{
					scenario: {
						collectionId: "col_1",
						dataFileName: "users.csv",
						dataFileHash: HASH,
					},
				},
				"scenario"
			)
		);
		expect(card).toContain("Data fileusers.csv");
		expect(card).not.toContain(HASH);
	});

	it("has no data file row for a run recorded without one", async () => {
		const card = await openCard(
			run({
				url: "https://api.example.test",
				method: "GET",
				scenario: { collectionId: "col_1" },
			})
		);
		expect(card).not.toContain("Data file");
	});
});
