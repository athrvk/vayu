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
 * A step's unresolved variables (issue #3269) show in its collapsed row beside
 * the extractor misses, live and stored alike, as a count of distinct names.
 *
 * Mutation-check: drop `<UnresolvedTokens>` from `ScenarioStepCard.tsx`'s title
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
	name: "List orders",
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

describe("ScenarioStepCard's unresolved variables", () => {
	it("counts them in the collapsed row, beside the extractor misses", () => {
		renderCard(step({ unresolvedTokens: 2, extractorMisses: 1 }));

		expect(screen.getByText("2 unresolved variables")).toBeTruthy();
		expect(screen.getByText("1 extractor miss")).toBeTruthy();
		// Beside a pass, not instead of it.
		expect(screen.getByText("passed")).toBeTruthy();
	});

	it("says one name in the singular", () => {
		renderCard(step({ unresolvedTokens: 1 }));

		expect(screen.getByText("1 unresolved variable")).toBeTruthy();
	});

	it("says nothing for a step that sent every name resolved, or a row from before the count", () => {
		renderCard(step({ unresolvedTokens: 0 }));
		expect(screen.queryByText(/unresolved variable/)).toBeNull();
		cleanup();

		renderCard(step({}));
		expect(screen.queryByText(/unresolved variable/)).toBeNull();
	});
});
