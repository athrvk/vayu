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
 * A step the run's Stop cut short (#3397) is stored with the cancelled
 * response: status 0, "Request cancelled". It is no failure, so the row wears
 * the Stopped glyph and chip, draws no "ERR" badge or time, and its expansion
 * carries no red Error block for the cancel.
 *
 * Mutation-check: drop `stopped` from the `answered` test in
 * `ScenarioStepCard.tsx` and the badge case fails; pass `step.result?.error`
 * through for a stopped step and the error-block case fails; map `stopped` to
 * `"error"` in `OUTCOME_STATE` and the glyph case fails.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ScenarioStepCard from "./ScenarioStepCard";
import type { ScenarioStepRow } from "../scenario-steps";

afterEach(cleanup);

const stoppedStep = (over: Partial<ScenarioStepRow> = {}): ScenarioStepRow => ({
	iteration: 0,
	stepIndex: 0,
	name: "slow-endpoint",
	outcome: "stopped",
	statusCode: 0,
	latencyMs: 1480,
	result: {
		timestamp: 1_700_000_000_000,
		statusCode: 0,
		latencyMs: 1480,
		error: "Request cancelled",
		trace: { outcome: "stopped" },
	} as ScenarioStepRow["result"],
	...over,
});

function renderCard(row: ScenarioStepRow, isExpanded = false) {
	return render(
		<ScenarioStepCard
			step={row}
			showIteration={false}
			isExpanded={isExpanded}
			onToggle={() => {}}
			runId="run_1"
		/>
	);
}

describe("ScenarioStepCard for a stopped step", () => {
	it("reads as stopped, not as an error", () => {
		const { container } = renderCard(stoppedStep());

		expect(screen.getByText("stopped")).toBeTruthy();
		// The Stopped glyph of the run's own status, in its own tint - never the
		// error icon or the destructive tint.
		const icon = container.querySelector("svg.lucide-circle-slash");
		expect(icon?.getAttribute("class")).toContain("text-status-stopped-text");
		expect(container.querySelector(".text-destructive-text")).toBeNull();
	});

	it("draws no status badge or time for the cancelled send", () => {
		renderCard(stoppedStep());

		expect(screen.queryByText("ERR")).toBeNull();
		expect(screen.queryByText(/ms$/)).toBeNull();
		expect(screen.queryByText(/s$/)).toBeNull();
	});

	it("shows no Error block for the cancel in the expansion", () => {
		renderCard(stoppedStep(), true);

		expect(screen.queryByText("Request cancelled")).toBeNull();
	});

	it("still shows the error of an errored step, which is one", () => {
		renderCard(
			stoppedStep({
				outcome: "errored",
				result: {
					timestamp: 1_700_000_000_000,
					statusCode: 0,
					latencyMs: 12,
					error: "connect refused",
					trace: { outcome: "errored" },
				} as ScenarioStepRow["result"],
			}),
			true
		);

		// The row's first-clause teaser and the expansion's Error block.
		expect(screen.getAllByText("connect refused").length).toBeGreaterThan(0);
		expect(screen.getByText("ERR")).toBeTruthy();
	});
});
