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
 * A step's schema verdict in the collection-run step list (issue #681).
 *
 * The two things worth pinning are the two the verdict exists to keep apart: a
 * step that passed every assertion while its response contradicted the contract
 * still shows both facts, and a step of an unbound collection shows neither -
 * absent is never rendered as "checked, and fine".
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ScenarioStepCard from "./ScenarioStepCard";
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

describe("ScenarioStepCard schema verdict", () => {
	it("shows a failed schema beside a passed step rather than instead of it", () => {
		// With `failOnSchemaError` off - the default - these are two separate
		// facts about one step, and collapsing either into the other is the
		// reading the verdict channel exists to prevent.
		renderCard(
			step({
				validation: { checked: true, valid: false, failuresTotal: 2 },
			})
		);

		expect(screen.getByText("passed")).toBeTruthy();
		expect(screen.getByText(/Schema failed/)).toBeTruthy();
	});

	it("renders no verdict at all for a step of an unbound collection", () => {
		renderCard(step());

		expect(screen.queryByText(/Schema/)).toBeNull();
	});

	it("says a bound response could not be checked rather than staying silent", () => {
		renderCard(step({ validation: { checked: false, reason: "no_schema_for_status" } }));

		expect(screen.getByText("Schema not checked")).toBeTruthy();
	});

	it("shows the failure detail inside the expansion, not only the chip", () => {
		renderCard(
			step({
				validation: {
					checked: true,
					valid: false,
					failuresTotal: 1,
					failures: [{ path: "/id", message: "unexpected instance type" }],
				},
			}),
			true
		);

		// The chip counts; the section names where. Without the detail a reader
		// has to re-run the step to learn anything actionable.
		expect(screen.getByText("/id")).toBeTruthy();
		expect(screen.getByText(/unexpected instance type/)).toBeTruthy();
	});

	/**
	 * The card takes the verdict from whichever source the row has - the live
	 * `step` event before the run ends, the restored response after. They are
	 * one object engine-side, and this is the assertion that keeps the two
	 * paths from drifting into two renderings of it.
	 */
	it("renders the same verdict live and read back from the stored trace", () => {
		const verdict = { checked: true, valid: false, failuresTotal: 3 };

		const live = renderCard(step({ validation: { ...verdict } }));
		const liveText = screen.getByText(/Schema failed/).textContent;
		live.unmount();

		renderCard(
			step({
				result: {
					timestamp: 1_700_000_000_000,
					statusCode: 200,
					latencyMs: 12,
					trace: {
						iteration: 0,
						stepIndex: 0,
						response: { headers: {}, body: "{}" },
						validation: { ...verdict },
					},
				},
			})
		);
		expect(screen.getByText(/Schema failed/).textContent).toBe(liveText);
	});

	it("discloses an unevaluated keyword rather than calling the match clean", () => {
		renderCard(
			step({
				validation: {
					checked: true,
					valid: true,
					unevaluatedKeywords: [{ keyword: "unevaluatedProperties", count: 1 }],
				},
			}),
			true
		);

		// "Matched schema" would overclaim: part of the contract was never read.
		expect(screen.getByText("Schema partly checked")).toBeTruthy();
		expect(screen.getByText(/was not evaluated/)).toBeTruthy();
	});
});
