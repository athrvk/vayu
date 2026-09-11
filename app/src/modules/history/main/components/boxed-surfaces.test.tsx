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
 * The history module's one remaining boxed `SampledExchange` row.
 *
 * `SampledExchange` itself deliberately carries no radius - "What differs by
 * site stays a slot, not a flag" - so the radius is the caller's job. A bare
 * `rounded` is caught by `radius-token.test.tsx`; the opposite escape hatch,
 * no radius class at all, pins the box at 0 for a user who chose Rounded and
 * no source scan can see it, because plenty of surfaces are square on
 * purpose. Only the component knows which it is, so this renders the caller
 * and reads `element.className`, the same pattern as
 * `request-builder/components/ResponseViewer/boxed-surfaces.test.tsx`.
 *
 * `ScenarioStepCard` had exactly this bug: `border border-rule` with the
 * radius left off, so a step's row stayed square-cornered regardless of the
 * Roundedness setting.
 *
 * `SampleRequestCard` is not tested here any more: it used to have the same
 * bug, but its row is now a flat `divide-y` strip (`border-b last:border-b-0`)
 * matching the dashboard's live sample list (`RequestResponseView.tsx`)
 * rather than a boxed card per row - square on purpose, the same category as
 * a header bar or a tab strip, which is why that file is not tested here
 * either.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

import ScenarioStepCard from "./ScenarioStepCard";
import type { ScenarioStepRow } from "../scenario-steps";

afterEach(cleanup);

/** `rounded-sm|md|lg|full` - anything that tracks the setting, or a deliberate circle. */
const HAS_RADIUS = /\brounded-(sm|md|lg|full)\b/;

function makeStep(overrides: Partial<ScenarioStepRow> = {}): ScenarioStepRow {
	return {
		iteration: 0,
		stepIndex: 0,
		name: "Get pet",
		outcome: "passed",
		statusCode: 200,
		latencyMs: 12,
		...overrides,
	};
}

/**
 * The row `SampledExchange` renders is the outermost element of the tree, and
 * it is the one carrying the caller's `className` - so it is what each of
 * these mounts and reads back.
 */
function outerRow(container: HTMLElement): HTMLElement {
	return container.firstElementChild as HTMLElement;
}

describe("ScenarioStepCard's row carries a radius in every outcome", () => {
	it("a skipped step", () => {
		const { container } = render(
			<ScenarioStepCard
				step={makeStep({ outcome: "skipped" })}
				showIteration={false}
				isExpanded={false}
				onToggle={() => {}}
				runId="run_1"
			/>
		);
		expect(outerRow(container).className).toMatch(HAS_RADIUS);
	});

	it("a failed step", () => {
		const { container } = render(
			<ScenarioStepCard
				step={makeStep({ outcome: "failed" })}
				showIteration={false}
				isExpanded={false}
				onToggle={() => {}}
				runId="run_1"
			/>
		);
		expect(outerRow(container).className).toMatch(HAS_RADIUS);
	});

	it("a passed step", () => {
		const { container } = render(
			<ScenarioStepCard
				step={makeStep({ outcome: "passed" })}
				showIteration={false}
				isExpanded={false}
				onToggle={() => {}}
				runId="run_1"
			/>
		);
		expect(outerRow(container).className).toMatch(HAS_RADIUS);
	});
});
