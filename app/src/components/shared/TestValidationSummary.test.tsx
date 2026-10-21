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
 * The shared test-validation block (issue #726).
 *
 * Four things are worth pinning and none of them are layout: that the four
 * numbers reach the screen under labels naming their unit (responses versus
 * assertions, issue #2144), that absent-not-zeros holds both ways, that the
 * tested-of-total line is true and absent without a denominator, and that a
 * failure list shorter than its count says so rather than reading as the whole
 * set of problems.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TestValidationSummary } from "./TestValidationSummary";

const TALLIES = {
	samplesTested: 100,
	testsPassed: 87,
	testsFailed: 13,
	successRate: 87,
};

describe("TestValidationSummary", () => {
	it("shows the four tallies a run's assertions produced", () => {
		render(<TestValidationSummary testValidation={TALLIES} sampling={undefined} />);

		expect(screen.getByText("Test validation")).toBeTruthy();
		// The unit is in the label: responses are tested, assertions pass and fail.
		for (const label of [
			"Responses tested",
			"Assertions passed",
			"Assertions failed",
			"Assertion success rate",
		]) {
			expect(screen.getByText(label)).toBeTruthy();
		}
		expect(screen.getByText("100")).toBeTruthy();
		expect(screen.getByText("87")).toBeTruthy();
		expect(screen.getByText("13")).toBeTruthy();
		expect(screen.getByText("87.0%")).toBeTruthy();
	});

	it("groups every count with thousands separators", () => {
		render(
			<TestValidationSummary
				testValidation={{
					samplesTested: 12_345,
					testsPassed: 23_456,
					testsFailed: 3_456,
					successRate: 87,
				}}
				sampling={undefined}
				failures={["x"]}
				failuresTotal={3_456}
			/>
		);

		expect(screen.getByText("12,345")).toBeTruthy();
		expect(screen.getByText("23,456")).toBeTruthy();
		// The failed figure, and the failed-tests heading's count.
		expect(screen.getAllByText("3,456").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("(3,456)")).toBeTruthy();
		expect(screen.getByText("Showing 1 of 3,456.")).toBeTruthy();
	});

	it("renders nothing for a run that asserted nothing", () => {
		// Absent, never a row of zeros: "this run had no tests" and "every
		// assertion failed" must not look the same.
		const { container } = render(
			<TestValidationSummary testValidation={undefined} sampling={undefined} />
		);

		expect(container.firstChild).toBeNull();
	});

	it("names each failure when given them", () => {
		render(
			<TestValidationSummary
				testValidation={TALLIES}
				sampling={undefined}
				failures={[
					"status is 200: expected 404 to equal 200",
					"body has token: expected undefined to exist",
				]}
				failuresTotal={2}
			/>
		);

		expect(screen.getByText("status is 200: expected 404 to equal 200")).toBeTruthy();
		expect(screen.getByText("body has token: expected undefined to exist")).toBeTruthy();
	});

	it("draws each failure as a blocking Callout, not a hand-rolled status box (#2317)", () => {
		render(
			<TestValidationSummary
				testValidation={TALLIES}
				sampling={undefined}
				failures={["status is 200: expected 404 to equal 200", "body has token"]}
				failuresTotal={2}
			/>
		);

		for (const message of ["status is 200: expected 404 to equal 200", "body has token"]) {
			const box = screen.getByText(message).closest(".border");
			expect(box).toHaveClass("border-destructive/40");
			expect(box?.className).not.toMatch(/status-/);
			expect(box?.querySelector("svg")).not.toBeNull();
		}
	});

	it("says a shorter list is a slice of a larger count", () => {
		render(
			<TestValidationSummary
				testValidation={TALLIES}
				sampling={undefined}
				failures={["status is 200: expected 404 to equal 200"]}
				failuresTotal={13}
			/>
		);

		expect(screen.getByText("Showing 1 of 13.")).toBeTruthy();
	});

	it("does not claim a slice when the list is the whole count", () => {
		render(
			<TestValidationSummary
				testValidation={TALLIES}
				sampling={undefined}
				failures={["only one"]}
				failuresTotal={1}
			/>
		);

		expect(screen.queryByText(/Showing/)).toBeNull();
	});

	it("still names failures for a report too old to carry the tallies", () => {
		// The failure row and the summary block are written by different engine
		// paths; a report with one and not the other must not swallow what it has.
		render(
			<TestValidationSummary
				testValidation={undefined}
				sampling={undefined}
				failures={["status is 200: expected 500 to equal 200"]}
				failuresTotal={1}
			/>
		);

		expect(screen.getByText("status is 200: expected 500 to equal 200")).toBeTruthy();
		expect(screen.queryByText("Responses tested")).toBeNull();
	});

	it("discloses what the tested-response store displaced", () => {
		render(
			<TestValidationSummary
				testValidation={TALLIES}
				sampling={{
					errorsDropped: 0,
					successTracesDropped: 0,
					slowTracesDropped: 0,
					responseSamplesDropped: 2_900,
				}}
			/>
		);

		expect(screen.getByText(/2,900 further responses were displaced/)).toBeTruthy();
	});

	describe("the tested-of-total line", () => {
		it("says how many of the run's requests were tested, and that the rest were not", () => {
			render(
				<TestValidationSummary
					testValidation={{ ...TALLIES, samplesTested: 1_000 }}
					sampling={undefined}
					totalRequests={235_690}
				/>
			);

			// The rest includes requests that never got a response, so the line
			// does not claim every missing one was displaced.
			expect(
				screen.getByText(
					"Tested 1,000 of 235,690 requests. The rest had no response or were not kept."
				)
			).toBeTruthy();
		});

		it("says all when every request was tested", () => {
			render(
				<TestValidationSummary
					testValidation={{ ...TALLIES, samplesTested: 100 }}
					sampling={undefined}
					totalRequests={100}
				/>
			);

			expect(screen.getByText("Tested all 100 requests.")).toBeTruthy();
			expect(screen.queryByText(/The rest/)).toBeNull();
		});

		it.each([undefined, 0])("is absent for a total of %s, never an 'of 0'", (totalRequests) => {
			render(
				<TestValidationSummary
					testValidation={TALLIES}
					sampling={undefined}
					totalRequests={totalRequests}
				/>
			);

			expect(screen.queryByText(/Tested/)).toBeNull();
		});

		it("never asserts uniformity beside it when the byte budget was spent", () => {
			render(
				<TestValidationSummary
					testValidation={{ ...TALLIES, samplesTested: 100 }}
					sampling={{
						errorsDropped: 0,
						successTracesDropped: 0,
						slowTracesDropped: 0,
						responseSamplesDropped: 2_900,
						responseSampleBudgetSpent: true,
					}}
					totalRequests={3_000}
				/>
			);

			expect(screen.getByText(/Tested 100 of 3,000 requests/)).toBeTruthy();
			expect(screen.getByText(/not uniformly from the whole of it/)).toBeTruthy();
			expect(screen.queryByText(/drawn uniformly from the whole run/)).toBeNull();
		});
	});
});
