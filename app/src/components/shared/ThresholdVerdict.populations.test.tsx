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
 * The assertion budget judges the worse of the exact inline population and the
 * sampled `pm.test` replay (#2892), so the row names the populations when the
 * sampled one decided anything, and says nothing when it did not exist.
 *
 * Mutation checks, each reverted and confirmed red: widening the sampled guard
 * to `!sampled` fails "absent when the sampled population is empty"; dropping
 * the `evaluated === false` guard fails "absent for an unevaluated check";
 * deleting the `sampleRate === 1` branch fails the every-response case; testing
 * `!exact` alone fails the sampled-only case; replacing `pluralize` with a
 * literal fails the singular case; reverting the scope to "on 1 in N responses"
 * fails all three period cases.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThresholdVerdict } from "./ThresholdVerdict";
import type { RunReport } from "@/types/domain";

type Verdict = NonNullable<RunReport["thresholdValidation"]>;
type Check = Verdict["checks"][number];

const assertionCheck = (over: Partial<Check> = {}): Check => ({
	metric: "maxAssertionFailureRatePct",
	limit: 10,
	actual: 50,
	passed: false,
	evaluated: true,
	...over,
});

const renderCheck = (check: Check) =>
	render(
		<ThresholdVerdict verdict={{ checks: [check], passed: 0, failed: 1, verdict: "failed" }} />
	);

const NOTE = /^Judged on/;

describe("ThresholdVerdict assertion populations", () => {
	it("names both populations and the sample period when the sampled one ran", () => {
		renderCheck(
			assertionCheck({
				assertionsExact: { passed: 2270, failed: 0 },
				assertionsSampled: { passed: 12, failed: 12 },
				sampleRate: 100,
			})
		);
		expect(
			screen.getByText(
				"Judged on the worse of 2,270 assertions on every response (0 failed) and 24 assertions on responses sampled at 1 in 100 (12 failed)."
			)
		).toBeInTheDocument();
	});

	it("says a single assertion in the singular", () => {
		renderCheck(
			assertionCheck({
				assertionsExact: { passed: 1, failed: 0 },
				assertionsSampled: { passed: 0, failed: 1 },
				sampleRate: 10,
			})
		);
		expect(
			screen.getByText(
				"Judged on the worse of 1 assertion on every response (0 failed) and 1 assertion on responses sampled at 1 in 10 (1 failed)."
			)
		).toBeInTheDocument();
	});

	it("names only the sampled population when the exact one is empty", () => {
		renderCheck(
			assertionCheck({
				assertionsExact: { passed: 0, failed: 0 },
				assertionsSampled: { passed: 3, failed: 1 },
				sampleRate: 50,
			})
		);
		expect(
			screen.getByText("Judged on 4 assertions on responses sampled at 1 in 50 (1 failed).")
		).toBeInTheDocument();
	});

	it.each([
		[1, "on every response"],
		[undefined, "on sampled responses"],
	])("words a sample period of %s as %s", (sampleRate, scope) => {
		renderCheck(
			assertionCheck({
				assertionsExact: { passed: 5, failed: 0 },
				assertionsSampled: { passed: 2, failed: 0 },
				sampleRate,
			})
		);
		expect(
			screen.getByText(new RegExp(`and 2 assertions ${scope} \\(0 failed\\)\\.$`))
		).toBeInTheDocument();
	});

	it("is absent for a check an older engine stored without the populations", () => {
		renderCheck(assertionCheck());
		expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
	});

	it("is absent for an unevaluated check", () => {
		renderCheck(
			assertionCheck({
				actual: undefined,
				evaluated: false,
				passed: true,
				assertionsSampled: { passed: 1, failed: 0 },
				sampleRate: 100,
			})
		);
		expect(screen.getByText("no samples")).toBeInTheDocument();
		expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
	});

	it("is absent when the sampled population is empty", () => {
		// A collection run, or a load run whose replay saw nothing: the exact
		// tally is the whole verdict and there is no second population to name.
		renderCheck(
			assertionCheck({
				assertionsExact: { passed: 40, failed: 6 },
				assertionsSampled: { passed: 0, failed: 0 },
			})
		);
		expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
	});
});
