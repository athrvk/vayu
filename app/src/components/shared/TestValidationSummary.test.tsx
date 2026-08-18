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
 * Three things are worth pinning and none of them are layout: that the four
 * numbers reach the screen, that absent-not-zeros holds both ways, and that a
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

		expect(screen.getByText("Test Validation")).toBeTruthy();
		expect(screen.getByText("100")).toBeTruthy();
		expect(screen.getByText("87")).toBeTruthy();
		expect(screen.getByText("13")).toBeTruthy();
		expect(screen.getByText("87.0%")).toBeTruthy();
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
		expect(screen.queryByText("Samples Tested")).toBeNull();
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
});
