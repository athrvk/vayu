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
 * The one read of `scenario.assertions` and the card name that follows from it
 * (#2820), and the deferred row's pointer at that card.
 *
 * Mutation-check: make `testValidationTitleOf` always answer "Test validation"
 * and the retitled case fails; always "Sampled replay" and the other two fail;
 * hard-code the pointer in `ElementTally` and the replay-card case fails.
 *
 * `replayScopeOf` (#2824): count every element kind instead of `script.*` and the
 * extractor case fails; count steps rather than the ones that deferred and the
 * step-count case fails; answer a scope for zero responses and the absent cases
 * fail.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { RunReport } from "@/types";
import { ElementTally } from "./ElementTally";
import {
	deferredResponsesOf,
	exactAssertionsOf,
	replayScopeOf,
	testValidationTitleOf,
} from "./run-assertions";

const withAssertions = {
	scenario: { assertions: { passed: 3, failed: 1 } },
} as unknown as RunReport;
const withoutAssertions = { scenario: { passed: 3 } } as unknown as RunReport;

describe("exactAssertionsOf", () => {
	it("reads the report's scenario.assertions", () => {
		expect(exactAssertionsOf(withAssertions)).toEqual({ passed: 3, failed: 1 });
	});

	it.each([
		["a scenario with no assertions", withoutAssertions],
		["a report with no scenario section", {} as RunReport],
		["no report", undefined],
		["a null report", null],
	])("is undefined for %s", (_name, report) => {
		expect(exactAssertionsOf(report)).toBeUndefined();
	});
});

describe("testValidationTitleOf", () => {
	it("retitles the card beside the exact Assertions card", () => {
		expect(testValidationTitleOf(withAssertions)).toBe("Sampled replay");
	});

	it.each([withoutAssertions, {} as RunReport, undefined])(
		"keeps Test validation otherwise",
		(report) => {
			expect(testValidationTitleOf(report)).toBe("Test validation");
		}
	);
});

describe("ElementTally's deferred pointer", () => {
	const deferred = {
		id: "el_1",
		kind: "script.post",
		passed: 0,
		failed: 0,
		skipped: 0,
		deferred: 40,
	};

	it("names the card it is given", () => {
		render(<ElementTally element={deferred} replayCard="Sampled replay" />);
		expect(screen.getByText(/results in Sampled replay$/)).toBeInTheDocument();
	});

	it("names Test validation by default", () => {
		render(<ElementTally element={deferred} />);
		expect(screen.getByText(/results in Test validation$/)).toBeInTheDocument();
	});
});

describe("replayScopeOf", () => {
	const element = (kind: string, deferred?: number) => ({
		id: kind,
		kind,
		passed: 0,
		failed: 0,
		skipped: 0,
		deferred,
	});
	const step = (index: number, elements: ReturnType<typeof element>[]) => ({
		index,
		name: `step ${index}`,
		requestId: `req_${index}`,
		method: "GET",
		executed: 100,
		errors: 0,
		latency: { min: 1, p50: 1, p95: 1, p99: 1, max: 1 },
		elements,
	});
	const reportOf = (steps: ReturnType<typeof step>[], assertions?: object) =>
		({ scenario: { steps, assertions } }) as unknown as RunReport;

	it("sums the deferred script responses and counts the steps that carried one", () => {
		const report = reportOf(
			[
				step(0, [element("assert.status", 0), element("extract.json", 5)]),
				step(1, [element("script.post", 2_270)]),
				step(2, [element("script.post", 30)]),
				step(3, []),
			],
			{ passed: 1, failed: 0 }
		);

		expect(replayScopeOf(report)).toEqual({
			responses: 2_300,
			steps: 2,
			assertionsCounted: true,
		});
	});

	it("reports the Assertions card as absent when the run has none", () => {
		const report = reportOf([step(0, [element("script.post", 10)])]);
		expect(replayScopeOf(report)?.assertionsCounted).toBe(false);
	});

	it.each([
		["a step with no deferred script", reportOf([step(0, [element("assert.status", 9)])])],
		["a report stored before `deferred`", reportOf([step(0, [element("script.post")])])],
		["a step with no elements", reportOf([step(0, [])])],
		["a single-request report", {} as RunReport],
		["no report", undefined],
	])("is undefined for %s", (_name, report) => {
		expect(replayScopeOf(report)).toBeUndefined();
	});

	it("deferredResponsesOf ignores non-script elements", () => {
		expect(
			deferredResponsesOf({
				elements: [element("script.post", 7), element("timer.delay", 3)],
			})
		).toBe(7);
	});
});
