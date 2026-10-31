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
 * A step's console output in the collection-run step list (issue #3126).
 *
 * The stored trace restored `consoleLogs` and both script errors onto the
 * response and the card never drew them, so a `console.warn` that explained a
 * failed step was visible after a single Send and nowhere inside a run. What is
 * pinned is that the response pane's own `ConsoleOutput` renders them, and that
 * a step with nothing to say gains no block.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ScenarioStepCard from "./ScenarioStepCard";
import type { ConsoleLogEntry } from "@/types";
import type { ScenarioStepRow } from "../scenario-steps";

afterEach(cleanup);

const step = (over: Partial<ScenarioStepRow> = {}): ScenarioStepRow => ({
	iteration: 0,
	stepIndex: 0,
	name: "Get pet",
	outcome: "passed",
	statusCode: 200,
	latencyMs: 12,
	...over,
});

/** A stored row whose trace carries the engine's `scripts` node. */
const storedWith = (scripts?: {
	consoleLogs?: ConsoleLogEntry[];
	postScriptError?: string;
}): ScenarioStepRow["result"] => ({
	timestamp: 1_700_000_000_000,
	statusCode: 200,
	latencyMs: 12,
	trace: {
		iteration: 0,
		stepIndex: 0,
		response: { headers: {}, body: "{}" },
		...(scripts && { scripts }),
	},
});

function renderExpanded(row: ScenarioStepRow) {
	return render(
		<ScenarioStepCard
			step={row}
			showIteration={false}
			isExpanded
			onToggle={() => {}}
			runId="run_1"
		/>
	);
}

describe("ScenarioStepCard console output", () => {
	it("shows a stored console line with its level label", () => {
		renderExpanded(
			step({
				result: storedWith({
					consoleLogs: [{ source: "test", level: "warn", message: "token expires soon" }],
				}),
			})
		);

		expect(screen.getByText("token expires soon")).toBeTruthy();
		expect(screen.getByText("warn")).toBeTruthy();
	});

	it("shows a post-request script error", () => {
		renderExpanded(
			step({
				outcome: "errored",
				result: storedWith({ postScriptError: "ReferenceError: pet is not defined" }),
			})
		);

		expect(screen.getByText("ReferenceError: pet is not defined")).toBeTruthy();
	});

	it("draws no console block for a step with no logs and no script error", () => {
		renderExpanded(step({ result: storedWith() }));

		expect(screen.queryByLabelText("Filter console output")).toBeNull();
		expect(screen.queryByText("No console output")).toBeNull();
	});

	it("draws no console block for a live row that has no stored result", () => {
		renderExpanded(step());

		expect(screen.queryByLabelText("Filter console output")).toBeNull();
		expect(screen.queryByText("No console output")).toBeNull();
	});
});
