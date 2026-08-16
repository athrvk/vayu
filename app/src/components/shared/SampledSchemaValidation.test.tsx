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
 * This block sits directly beside a coverage block whose every number is exact,
 * so the ways it could mislead are all versions of one mistake: letting a reader
 * take a sampled figure for a whole-run one. Showing a block for a run that
 * checked nothing, printing a matched count without the denominator it came
 * from, or reporting a body no schema could describe as a failure would each do
 * it, and each has a case here.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SampledSchemaValidation } from "./SampledSchemaValidation";
import { UNCHECKED_REASONS } from "./response-viewer/validation-reasons";
import type { RunSchemaValidation } from "@/types/domain";

afterEach(cleanup);

const validation = (over: Partial<RunSchemaValidation> = {}): RunSchemaValidation => ({
	sampled: 40,
	checked: 36,
	valid: 30,
	failed: 6,
	unevaluated: 0,
	uncheckedReasons: { body_not_json: 4 },
	failures: [{ step: "get pet", status: 200, path: "/id", message: "expected integer" }],
	failuresTotal: 6,
	...over,
});

describe("SampledSchemaValidation", () => {
	it("renders nothing for a run that checked nothing", () => {
		// Absent and "walked no samples" both mean not checked. Neither may
		// render a block, because a block saying nothing failed is a claim about
		// a contract this run was never judged against.
		//
		// Mutation-check: drop the `sampled <= 0` half of the guard and the
		// second render below produces a card reading "0 / 0 matched".
		const { container: absent } = render(<SampledSchemaValidation validation={undefined} />);
		expect(absent.innerHTML).toBe("");

		cleanup();
		const { container: empty } = render(
			<SampledSchemaValidation
				validation={validation({
					sampled: 0,
					checked: 0,
					valid: 0,
					failed: 0,
					uncheckedReasons: {},
					failures: [],
					failuresTotal: 0,
				})}
			/>
		);
		expect(empty.innerHTML).toBe("");
	});

	it("shows the sampled denominator beside the tallies", () => {
		render(<SampledSchemaValidation validation={validation()} />);

		expect(screen.getByText("30 / 36 matched")).toBeTruthy();
		// The denominator is the whole point: without "of 40 sampled" a reader
		// takes 36 for the number of responses the run made.
		expect(screen.getByText(/36 of 40 sampled responses checked/)).toBeTruthy();
		expect(screen.getByText(/6 did not match their declared schema/)).toBeTruthy();
	});

	/**
	 * A collection run writes this same block having checked every step it ran
	 * (issue #681). Telling that reader their figures describe a sample is the
	 * mirror of the mistake the sampled wording exists to prevent - narrower
	 * than the truth rather than wider, but still not what happened.
	 */
	it("drops the sampled wording when the run checked everything", () => {
		render(<SampledSchemaValidation validation={validation({ exact: true })} />);

		expect(screen.getByText(/36 of 40 responses checked/)).toBeTruthy();
		expect(screen.queryByText(/sampled/i)).toBeNull();
		expect(screen.getByText(/over every response this run produced/i)).toBeTruthy();
		expect(screen.queryByText(/Coverage beside this is exact/)).toBeNull();
	});

	it("falls back to the sampled reading when the report does not say", () => {
		// A report written before `exact` existed was a load run's. Defaulting the
		// other way would have every one of them overclaim.
		render(<SampledSchemaValidation validation={validation()} />);
		expect(screen.getByText(/36 of 40 sampled responses checked/)).toBeTruthy();
	});

	it("says the numbers describe the sample, beside a coverage block that is exact", () => {
		render(<SampledSchemaValidation validation={validation()} />);

		// Stated in the block rather than left to the docs, for the same reason
		// the coverage block states the opposite: the two sit together and a
		// reader has no other way to tell which kind each is.
		expect(screen.getByText(/Coverage beside this is exact/)).toBeTruthy();
		expect(screen.getByText(/over the responses it kept/)).toBeTruthy();
	});

	it("accounts for unchecked samples by reason, in the wording the response viewer uses", () => {
		render(<SampledSchemaValidation validation={validation()} />);

		// One list of sentences, shared with the single-response pane. A second
		// copy here would drift from what a user reads on their own response.
		const row = screen.getByText(new RegExp(UNCHECKED_REASONS.body_not_json));
		expect(row.textContent).toContain("4");
		expect(row.textContent).toContain("not checked");
	});

	it("names the keywords that went unevaluated rather than only counting them", () => {
		render(
			<SampledSchemaValidation
				validation={validation({
					unevaluated: 3,
					unevaluatedKeywords: [
						{ keyword: "unevaluatedProperties", count: 3 },
						{ keyword: "prefixItems", count: 1 },
					],
				})}
			/>
		);

		// A green count beside a schema half of which went unread is the failure
		// mode the disclosure exists for, so the keywords are named.
		expect(screen.getByText(/unevaluatedProperties \(3\), prefixItems/)).toBeTruthy();
		expect(screen.getByText(/neither checked nor failed/)).toBeTruthy();
	});

	it("discloses that the failure list is shorter than the count", () => {
		render(
			<SampledSchemaValidation validation={validation({ failuresTotal: 90, failed: 40 })} />
		);

		// A list shorter than the count reads as the whole set of problems
		// unless it says otherwise.
		expect(screen.getByText("Showing 1 of 90.")).toBeTruthy();
	});

	it("stays neutral when nothing failed rather than borrowing the failure vocabulary", () => {
		render(
			<SampledSchemaValidation
				validation={validation({
					valid: 36,
					failed: 0,
					failures: [],
					failuresTotal: 0,
				})}
			/>
		);

		const chip = screen.getByText("36 / 36 matched");
		expect(chip.className).toContain("text-status-success-text");
		// A run with nothing wrong must not print a failure sentence.
		expect(screen.queryByText(/did not match/)).toBeNull();
	});
});
