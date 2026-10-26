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
 * A skipped step sent nothing (#2824). The engine stores its row with status 0
 * and latency 0, and the shared row would draw "ERR" and "0ms" for them, so the
 * card hands it neither.
 *
 * Mutation-check: pass `step.statusCode` / `step.latencyMs` unconditionally in
 * `ScenarioStepCard.tsx` and the skipped case fails; make `SampledExchange`
 * draw its badge or time for an absent value and the same case fails.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ScenarioStepCard from "./ScenarioStepCard";
import type { ScenarioStepRow } from "../scenario-steps";

afterEach(cleanup);

const step = (over: Partial<ScenarioStepRow>): ScenarioStepRow => ({
	iteration: 0,
	stepIndex: 0,
	name: "if-flag-no",
	outcome: "passed",
	statusCode: 200,
	latencyMs: 12,
	...over,
});

function renderCard(row: ScenarioStepRow) {
	return render(
		<ScenarioStepCard
			step={row}
			showIteration={false}
			isExpanded={false}
			onToggle={() => {}}
			runId="run_1"
		/>
	);
}

describe("ScenarioStepCard for a skipped step", () => {
	it("keeps the skipped chip and draws no status badge or time", () => {
		renderCard(step({ outcome: "skipped", statusCode: 0, latencyMs: 0 }));

		expect(screen.getByText("skipped")).toBeTruthy();
		expect(screen.queryByText(/ERR/)).toBeNull();
		expect(screen.queryByText(/ms$/)).toBeNull();
	});

	it("still draws the badge and the time for a step that ran", () => {
		renderCard(step({}));

		expect(screen.getByText("200")).toBeTruthy();
		expect(screen.getByText("12ms")).toBeTruthy();
	});

	it("still shows ERR for an errored step, which did try the wire", () => {
		renderCard(step({ outcome: "errored", statusCode: 0, latencyMs: 0 }));

		expect(screen.getByText("ERR")).toBeTruthy();
	});
});
