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
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { RunReport } from "@/types";
import { ElementTally } from "./ElementTally";
import { exactAssertionsOf, testValidationTitleOf } from "./run-assertions";

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
