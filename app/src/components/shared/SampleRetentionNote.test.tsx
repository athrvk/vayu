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
 * cases that matter are the four ways it can lie: claiming completeness when
 * records were displaced, claiming a loss when there was none, asserting either
 * against a run that never reported the counts, and calling a set uniform when
 * the run's byte budget is what thinned it (issue #1192).
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

	// The store is bounded twice and one counter reports both, so the marker is
	// the only thing that says whether the uniformity sentence is true. Drop the
	// branch and this case reddens: the note claims a uniform sample of a run
	// that was graded on its cheap-bodied part.
	it("does not claim uniformity when the byte budget is what thinned the tested set", () => {
		render(
			<SampleRetentionNote
				sampling={sampling({
					responseSamplesDropped: 998_000,
					responseSampleBudgetSpent: true,
				})}
				shown={1_000}
				budget="responses"
			/>
		);

		expect(
			screen.getByText(/1,000 tested are drawn from the part of the run whose bodies fit/)
		).toBeInTheDocument();
		expect(screen.queryByText(/drawn uniformly from the whole run/)).not.toBeInTheDocument();
	});

	it("keeps the uniformity sentence for a run the count cap alone thinned", () => {
		render(
			<SampleRetentionNote
				sampling={sampling({
					responseSamplesDropped: 998_000,
					responseSampleBudgetSpent: false,
				})}
				shown={1_000}
				budget="responses"
			/>
		);

		expect(
			screen.getByText(/1,000 tested are drawn uniformly from the whole run/)
		).toBeInTheDocument();
	});

	// A run recorded before the engine reported which bound applied. Weakening
	// the copy for every such run costs the accurate message in the case that is
	// nearly all of them, so absent reads as today's sentence - it just must not
	// read as the budget-spent one, which would assert a bias nothing measured.
	it("reads a run recorded before the marker as today's message, not as budget-spent", () => {
		render(
			<SampleRetentionNote
				sampling={sampling({ responseSamplesDropped: 900 })}
				shown={40}
				budget="responses"
			/>
		);

		expect(
			screen.getByText(/40 tested are drawn uniformly from the whole run/)
		).toBeInTheDocument();
		expect(screen.queryByText(/whose bodies fit/)).not.toBeInTheDocument();
	});

	// The marker belongs to the response store alone; a trace surface reading it
	// would describe the list on screen by a budget it was never charged to.
	it("ignores the response-budget marker on a trace surface", () => {
		render(
			<SampleRetentionNote
				sampling={sampling({
					successTracesDropped: 29_000,
					responseSampleBudgetSpent: true,
				})}
				shown={100}
				budget="traces"
			/>
		);

		expect(
			screen.getByText(/100 shown are drawn uniformly from the whole run/)
		).toBeInTheDocument();
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
