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
 * The history module's two boxed `SampledExchange` rows.
 *
 * `SampledExchange` itself deliberately carries no radius - "What differs by
 * site stays a slot, not a flag" - so the radius is the caller's job. A bare
 * `rounded` is caught by `radius-token.test.tsx`; the opposite escape hatch,
 * no radius class at all, pins the box at 0 for a user who chose Rounded and
 * no source scan can see it, because plenty of surfaces are square on
 * purpose. Only the component knows which it is, so this renders both callers
 * and reads `element.className`, the same pattern as
 * `request-builder/components/ResponseViewer/boxed-surfaces.test.tsx`.
 *
 * `SampleRequestCard` had exactly this bug: `border transition-colors` with
 * no radius class, so a stored sample's row stayed square-cornered regardless
 * of the Roundedness setting. `ScenarioStepCard` had the same shape of bug -
 * `border border-rule` with the radius left off.
 *
 * `RequestResponseView`'s row is not tested here: it is a `divide-y` list
 * strip (`border-b last:border-b-0`, no left/right/corner border at all)
 * inside a `Card` that already owns the rounding, so it is square on purpose,
 * the same category as a header bar or a tab strip.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

import SampleRequestCard from "./SampleRequestCard";
import ScenarioStepCard from "./ScenarioStepCard";
import type { SampleResult } from "../../types";
import type { ScenarioStepRow } from "../scenario-steps";

afterEach(cleanup);

/** `rounded-sm|md|lg|full` - anything that tracks the setting, or a deliberate circle. */
const HAS_RADIUS = /\brounded-(sm|md|lg|full)\b/;

function makeSample(overrides: Partial<SampleResult> = {}): SampleResult {
	return {
		timestamp: 1_700_000_000_000,
		statusCode: 200,
		latencyMs: 5,
		...overrides,
	};
}

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

describe("SampleRequestCard's row carries a radius in every outcome", () => {
	it("a plain (neither error nor success) sample", () => {
		const { container } = render(
			<SampleRequestCard
				sample={makeSample({ statusCode: 302 })}
				index={0}
				isExpanded={false}
				onToggle={() => {}}
			/>
		);
		expect(outerRow(container).className).toMatch(HAS_RADIUS);
	});

	it("an error sample", () => {
		const { container } = render(
			<SampleRequestCard
				sample={makeSample({ statusCode: 0, error: "connect: timed out" })}
				index={0}
				isExpanded={false}
				onToggle={() => {}}
			/>
		);
		expect(outerRow(container).className).toMatch(HAS_RADIUS);
	});

	it("a success sample", () => {
		const { container } = render(
			<SampleRequestCard
				sample={makeSample({ statusCode: 200 })}
				index={0}
				isExpanded={false}
				onToggle={() => {}}
			/>
		);
		expect(outerRow(container).className).toMatch(HAS_RADIUS);
	});
});

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
