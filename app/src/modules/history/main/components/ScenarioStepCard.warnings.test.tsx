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
 * What the engine did to a step's exchange that its response does not show
 * (issue #3307). The stored trace carries `warnings` and `responseFromRunResult`
 * maps them; the step's viewer has no status bar or band of its own, so the card
 * draws them, including on a step that never reached a server.
 *
 * Mutation-check: drop `<ExchangeWarnings>` from `ScenarioStepCard.tsx` and the
 * first two cases fail.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ScenarioStepCard from "./ScenarioStepCard";
import type { ScenarioStepRow } from "../scenario-steps";
import type { ExchangeWarning } from "@/types";

afterEach(cleanup);

const WARNING: ExchangeWarning = {
	code: "cookie_not_sent",
	message: "The cookie 'session' did not fit in the 8190 byte Cookie header and was left out.",
};

function storedStep(warnings: ExchangeWarning[] | undefined): ScenarioStepRow {
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
			trace: {
				iteration: 0,
				stepIndex: 0,
				response: { headers: {}, body: "{}" },
				...(warnings && { warnings }),
			},
		},
	};
}

/** A transfer that never reached a server: no `response` node, only an error. */
function failedStep(warnings: ExchangeWarning[]): ScenarioStepRow {
	return {
		iteration: 0,
		stepIndex: 0,
		name: "Get pet",
		outcome: "failed",
		statusCode: 0,
		latencyMs: 3,
		result: {
			timestamp: 1_700_000_000_000,
			statusCode: 0,
			latencyMs: 3,
			trace: {
				iteration: 0,
				stepIndex: 0,
				error_type: "ConnectionError",
				error_message: "refused",
				warnings,
			},
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

describe("ScenarioStepCard exchange warnings", () => {
	it("draws the engine's sentence under a title for its code", () => {
		renderExpanded(storedStep([WARNING]));

		expect(screen.getByText("A cookie did not fit the Cookie header")).toBeTruthy();
		expect(screen.getByText(/The cookie 'session' did not fit/)).toBeTruthy();
	});

	it("draws them on a step that failed before any response", () => {
		renderExpanded(failedStep([WARNING]));

		expect(screen.getByText(/The cookie 'session' did not fit/)).toBeTruthy();
	});

	it("says nothing for a step stored without the key", () => {
		renderExpanded(storedStep(undefined));

		expect(screen.queryByText(/did not fit/)).toBeNull();
		expect(screen.queryByText("Note on this send")).toBeNull();
	});
});
