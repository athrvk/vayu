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
 * The note exists to stop a sampled list from reading as a complete one, so the
 * cases that matter are the three ways it can lie: claiming completeness when
 * records were displaced, claiming a loss when there was none, and asserting
 * either against a run that never reported the counts.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SampleRetentionNote } from "./SampleRetentionNote";
import type { RunReport } from "@/types/domain";

const sampling = (over: Partial<NonNullable<RunReport["sampling"]>> = {}) => ({
	errorsDropped: 0,
	successTracesDropped: 0,
	slowTracesDropped: 0,
	responseSamplesDropped: 0,
	...over,
});

describe("SampleRetentionNote", () => {
	it("reports what a bounded trace store displaced, and what the shown set therefore is", () => {
		render(
			<SampleRetentionNote
				sampling={sampling({ successTracesDropped: 28_000, slowTracesDropped: 1_000 })}
				shown={100}
				budget="traces"
			/>
		);

		// Both trace budgets are one story to a reader looking at one list.
		expect(screen.getByText(/29,000 further samples were displaced/)).toBeInTheDocument();
		expect(
			screen.getByText(/100 shown are drawn uniformly from the whole run/)
		).toBeInTheDocument();
	});

	it("reads the response budget for the validation surface, not the trace one", () => {
		render(
			<SampleRetentionNote
				sampling={sampling({ successTracesDropped: 5, responseSamplesDropped: 998_000 })}
				shown={1_000}
				budget="responses"
			/>
		);

		expect(screen.getByText(/998,000 further responses were displaced/)).toBeInTheDocument();
		expect(screen.getByText(/1,000 tested/)).toBeInTheDocument();
	});

	it("says nothing when the run displaced nothing", () => {
		const { container } = render(
			<SampleRetentionNote sampling={sampling()} shown={12} budget="traces" />
		);
		expect(container).toBeEmptyDOMElement();
	});

	// A run whose summary predates the counts cannot support either claim. The
	// engine deliberately omits the section rather than sending zeros for it, so
	// treating absent as "nothing dropped" would turn "we cannot tell" into an
	// assurance of completeness.
	it("stays silent when the run reported no retention counts at all", () => {
		const { container } = render(
			<SampleRetentionNote sampling={undefined} shown={12} budget="traces" />
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("does not fire on a store that was bounded but never displaced anything", () => {
		const { container } = render(
			<SampleRetentionNote
				sampling={sampling({ responseSamplesDropped: 900 })}
				shown={40}
				budget="traces"
			/>
		);
		// The response budget thinned; the trace list this surface shows did not.
		expect(container).toBeEmptyDOMElement();
	});
});
