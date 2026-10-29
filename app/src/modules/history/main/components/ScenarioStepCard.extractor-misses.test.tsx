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
 * A step's extractor misses (issue #3053) show in its collapsed row, live and
 * stored alike: the step can pass while its extractor found nothing.
 *
 * Mutation-check: drop `<ExtractorMisses>` from `ScenarioStepCard.tsx`'s title
 * and the first two cases fail; drop its `count > 0` guard and the last does.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ScenarioStepCard from "./ScenarioStepCard";
import type { ScenarioStepRow } from "../scenario-steps";

afterEach(cleanup);

const step = (over: Partial<ScenarioStepRow>): ScenarioStepRow => ({
	iteration: 1,
	stepIndex: 0,
	name: "Log in",
	outcome: "passed",
	statusCode: 200,
	latencyMs: 12,
	...over,
});

function renderCard(row: ScenarioStepRow) {
	return render(
		<ScenarioStepCard
			step={row}
			showIteration
			isExpanded={false}
			onToggle={() => {}}
			runId="run_1"
		/>
	);
}

describe("ScenarioStepCard's extractor misses", () => {
	it("counts them in the collapsed row", () => {
		renderCard(step({ extractorMisses: 2 }));

		expect(screen.getByText("2 extractor misses")).toBeTruthy();
		// Beside a pass, not instead of it.
		expect(screen.getByText("passed")).toBeTruthy();
	});

	it("says one miss in the singular", () => {
		renderCard(step({ extractorMisses: 1 }));

		expect(screen.getByText("1 extractor miss")).toBeTruthy();
	});

	it("says nothing for a step that missed nothing, or a row from before the count", () => {
		renderCard(step({ extractorMisses: 0 }));
		expect(screen.queryByText(/extractor miss/)).toBeNull();
		cleanup();

		renderCard(step({}));
		expect(screen.queryByText(/extractor miss/)).toBeNull();
	});
});
