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
 * A step that asked for HTTP/2 and ran on something older (issue #3262).
 *
 * The trace carried the engine's `httpVersionDowngraded` and the restore path
 * mapped it, but the step's viewer has no status bar, so nothing drew it. What
 * is pinned is the line appearing for a flagged step and only for one.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ScenarioStepCard from "./ScenarioStepCard";
import type { ScenarioStepRow } from "../scenario-steps";

afterEach(cleanup);

/** A stored row whose response negotiated `httpVersion`, flagged or not. */
function storedStep(response: {
	httpVersion?: string;
	httpVersionDowngraded?: boolean;
}): ScenarioStepRow {
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
				response: { headers: {}, body: "{}", ...response },
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

describe("ScenarioStepCard protocol downgrade", () => {
	it("names the protocol a flagged step actually used", () => {
		renderExpanded(storedStep({ httpVersion: "HTTP/1.1", httpVersionDowngraded: true }));

		expect(screen.getByText("HTTP/1.1, not HTTP/2")).toBeTruthy();
	});

	it("says nothing for a step that got the protocol it asked for", () => {
		renderExpanded(storedStep({ httpVersion: "HTTP/2", httpVersionDowngraded: false }));

		expect(screen.queryByText(/not HTTP\/2/)).toBeNull();
	});

	it("says nothing for a step stored before the engine recorded the flag", () => {
		renderExpanded(storedStep({ httpVersion: "HTTP/1.1" }));

		expect(screen.queryByText(/not HTTP\/2/)).toBeNull();
	});
});
