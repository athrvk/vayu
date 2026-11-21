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
 * The time a step's scripts took (#3739). The engine stores it flat on the
 * step's trace as `scriptMs`, beside the network phases, and a step that waited
 * seconds on a script has no other place that says so: the row's latency is the
 * transfer's. The expansion draws it as the "Scripts" tile of the timing
 * breakdown; a reported `0` is drawn (the script ran), an absent one is not.
 *
 * Mutation-check: drop `scriptMs={...}` from the `SampledExchange` in
 * `ScenarioStepCard.tsx` and the first two cases fail.
 */

import { describe, it, expect, afterEach } from "vitest";
import { screen, cleanup } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import ScenarioStepCard from "./ScenarioStepCard";
import type { ScenarioStepRow } from "../scenario-steps";

afterEach(cleanup);

function storedStep(trace: Record<string, number>): ScenarioStepRow {
	return {
		iteration: 0,
		stepIndex: 0,
		name: "Get pet",
		outcome: "passed",
		statusCode: 200,
		latencyMs: 12,
		result: {
			timestamp: 1_700_000_000_000,
			statusCode: 200,
			latencyMs: 12,
			trace: { iteration: 0, stepIndex: 0, response: { headers: {}, body: "{}" }, ...trace },
		},
	};
}

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

describe("ScenarioStepCard script time", () => {
	it("draws the script time the step reported", () => {
		renderExpanded(storedStep({ scriptMs: 3010 }));

		expect(screen.getByText("Timing breakdown")).toBeInTheDocument();
		expect(screen.getByText("Scripts").parentElement).toHaveTextContent("3.01s");
	});

	it("draws a reported zero", () => {
		renderExpanded(storedStep({ scriptMs: 0 }));

		expect(screen.getByText("Scripts").parentElement).toHaveTextContent("0ms");
	});

	it("draws no Scripts tile when the step did not report one", () => {
		renderExpanded(storedStep({ dnsMs: 1 }));

		expect(screen.getByText("Timing breakdown")).toBeInTheDocument();
		expect(screen.queryByText("Scripts")).toBeNull();
	});
});
