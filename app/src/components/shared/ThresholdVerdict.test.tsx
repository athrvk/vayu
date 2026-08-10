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
 * The verdict's job is to be unambiguous about a run that failed its budget, so
 * the cases that matter are the ways it could mislead: showing nothing for a
 * run that was judged, showing a section for one that was not, printing a floor
 * as if it were a ceiling, or silently dropping a check a newer engine sent.
 */

import { describe, it, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ThresholdVerdict } from "./ThresholdVerdict";
import type { RunReport } from "@/types/domain";

type Verdict = NonNullable<RunReport["thresholdValidation"]>;

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
	checks: [{ metric: "latencyP99Ms", limit: 50, actual: 47.2, passed: true }],
	passed: 1,
	failed: 0,
	verdict: "passed",
	...over,
});

describe("ThresholdVerdict", () => {
	it("renders nothing for a run that declared no budgets", () => {
		// Every run recorded before budgets existed is this run. "Not judged"
		// has to read as absence, not as a card full of zeros.
		const { container } = render(<ThresholdVerdict verdict={undefined} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing for a section carrying no checks", () => {
		const { container } = render(
			<ThresholdVerdict verdict={verdict({ checks: [], passed: 0, failed: 0 })} />
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("says a run passed, with the measurement beside the budget it met", () => {
		render(<ThresholdVerdict verdict={verdict()} />);
		expect(screen.getByText("Passed")).toBeInTheDocument();
		expect(screen.getByText("1 of 1 budgets met.")).toBeInTheDocument();
		expect(screen.getByText(/p99 latency/)).toBeInTheDocument();
		expect(screen.getByText("47.20ms")).toBeInTheDocument();
	});

	it("says a run failed when any single budget was missed", () => {
		// The whole point of the verdict: four green checks do not make a pass.
		render(
			<ThresholdVerdict
				verdict={verdict({
					checks: [
						{ metric: "latencyP50Ms", limit: 20, actual: 10, passed: true },
						{ metric: "maxErrorRatePct", limit: 0.1, actual: 1, passed: false },
					],
					passed: 1,
					failed: 1,
					verdict: "failed",
				})}
			/>
		);
		expect(screen.getByText("Failed")).toBeInTheDocument();
		expect(screen.getByText("1 of 2 budgets met.")).toBeInTheDocument();
	});

	it("prints a throughput floor as a floor, not as a ceiling", () => {
		// Every other budget is a ceiling, so a shared comparator would describe
		// the opposite budget from the one the verdict was computed against.
		render(
			<ThresholdVerdict
				verdict={verdict({
					checks: [
						{ metric: "minThroughputRps", limit: 1000, actual: 900, passed: false },
					],
					passed: 0,
					failed: 1,
					verdict: "failed",
				})}
			/>
		);
		expect(screen.getByText(/≥ 1000req\/s/)).toBeInTheDocument();
	});

	it("prints the ceilings with the comparator that matches them", () => {
		render(<ThresholdVerdict verdict={verdict()} />);
		expect(screen.getByText(/≤ 50ms/)).toBeInTheDocument();
	});

	it("shows a metric it has no label for rather than dropping it", () => {
		// The counts come from the engine. A check rendered away would leave
		// "1 of 2 budgets met" above a single row and no way to see the other.
		render(
			<ThresholdVerdict
				verdict={verdict({
					checks: [{ metric: "latencyP999Ms", limit: 80, actual: 90, passed: false }],
					passed: 0,
					failed: 1,
					verdict: "failed",
				})}
			/>
		);
		expect(screen.getByText(/latencyP999Ms/)).toBeInTheDocument();
		expect(screen.getByText("90")).toBeInTheDocument();
	});

	it("keeps a whole-number budget whole", () => {
		cleanup();
		render(
			<ThresholdVerdict
				verdict={verdict({
					checks: [{ metric: "maxErrorRatePct", limit: 0, actual: 0, passed: true }],
				})}
			/>
		);
		expect(screen.getByText(/≤ 0%/)).toBeInTheDocument();
		expect(screen.getByText("0%")).toBeInTheDocument();
	});

	it("paints the verdict chip through the Badge primitive, radius included", () => {
		// Rendered and read off `className`, not source-scanned: the colour
		// arrives in a variable, and a box with *no* radius class is exactly
		// what no scan can see (app/CLAUDE.md). Mutation check: revert the
		// `<Badge variant="chip">` to the hand-rolled `<span>` this used to be
		// and the radius assertion fails - the box was pinned square for anyone
		// on the Rounded setting.
		render(<ThresholdVerdict verdict={verdict({ failed: 1, passed: 0, verdict: "failed" })} />);
		const chip = screen.getByText("Failed");
		expect(chip.className).toMatch(/\brounded-(sm|md|lg)\b/);
		// The tint plus a `-text` token, never the bare indicator fill as a
		// foreground - the three-token rule the status guards enforce.
		expect(chip.className).toContain("text-destructive-text");
		// Lookahead, not a bare word boundary: `-` is a word boundary, so
		// `\btext-destructive\b` matches the prefix of `text-destructive-text`
		// and the assertion would fail on the correct token.
		expect(chip.className).not.toMatch(/\btext-destructive(?!-text)\b/);
		cleanup();
	});
});
