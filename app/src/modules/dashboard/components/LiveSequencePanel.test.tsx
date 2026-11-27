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
 * The live sequence panel's step rows (issue #3987): an mcp step's gate-frame `label` names the
 * call it makes and is drawn beside the step name, as History's Steps tab draws it; a step
 * without one shows its name alone.
 *
 * Mutation-check: drop `label={step.label}` from the panel's `StepLabelCell` and the labelled-row
 * case fails.
 */

import { describe, it, expect } from "vitest";
import { screen, within } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import type { LiveScenarioProgress } from "@/types";
import LiveSequencePanel from "./LiveSequencePanel";

const PROGRESS: LiveScenarioProgress = {
	iterations: 4,
	iterationsCompleted: 3,
	iterationsAbandoned: 0,
	stepsExecuted: 7,
	steps: [
		{ index: 0, name: "Search", executed: 4, errors: 0, label: "tools/call a" },
		{ index: 1, name: "List orders", executed: 3, errors: 1 },
	],
};

describe("LiveSequencePanel step labels", () => {
	it("draws an mcp step's label beside its name and no label on a step without one", () => {
		render(<LiveSequencePanel progress={PROGRESS} />);

		const [labelled, plain] = screen.getAllByRole("row").slice(1); // drop the header row
		expect(within(labelled).getByText("Search")).toBeTruthy();
		expect(within(labelled).getByText("tools/call a")).toBeTruthy();
		expect(within(plain).getByText("List orders")).toBeTruthy();
		expect(screen.getAllByText("tools/call a")).toHaveLength(1);
	});
});
