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
 * A finished load run's row says how it went (#2130).
 *
 * `completed` was the whole answer, so a run that missed every budget and one
 * that sailed through were the same green tick. The row now carries the verdict
 * as the glyph's shape, the headline numbers as a line, and the run's comment
 * as a line of its own rather than a hover row.
 *
 * Mutation check: make `rowOutcome` ignore `resultSummary` and the glyph and
 * accessible-name cases redden; drop the `resultLine` render and the subtitle
 * case reddens; move the comment back into the time card and the comment case
 * reddens.
 *
 * Failed assertions (#2820): drop `assertionsFailed` from `rowOutcome`'s input
 * and the glyph and accessible-name cases redden; drop it from `resultSubtitle`
 * and the line case reddens.
 */

import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import RunItem from "./RunItem";
import type { Run } from "@/types";

function loadRun(overrides: Partial<Run> = {}): Run {
	return {
		id: "run_1",
		type: "load",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_003_000,
		requestId: "req_1",
		environmentId: null,
		summary: { url: "https://api.example.test/checkout", method: "POST" },
		...overrides,
	} as Run;
}

const noop = () => {};

function renderRow(run: Run) {
	return render(<RunItem run={run} onSelect={noop} onDelete={noop} isDeleting={false} />);
}

/** The status glyph's markup with every colour class removed. */
function glyphShape(run: Run): string {
	const { container, unmount } = renderRow(run);
	const markup = container.querySelector("svg")!.outerHTML.replace(/class="[^"]*"/g, "");
	unmount();
	return markup;
}

const RESULT = { rps: 485.3, p95Ms: 42, errorRate: 0 };

describe("a load run's result line", () => {
	it("prints throughput, p95 and error rate", () => {
		renderRow(loadRun({ resultSummary: { ...RESULT, verdict: "passed" } }));

		expect(screen.getByText("485 req/s · p95 42ms · 0.0% errors")).toBeInTheDocument();
	});

	it("leaves out a figure the run did not record", () => {
		renderRow(loadRun({ resultSummary: { p95Ms: 42 } }));

		expect(screen.getByText("p95 42ms")).toBeInTheDocument();
	});

	it("prints no line for a row without a summary, or for a run that is not a load run", () => {
		const { container, unmount } = renderRow(loadRun());
		expect(container.textContent).not.toContain("req/s");
		unmount();

		const design = renderRow(
			loadRun({ type: "design", resultSummary: { statusCode: 200, latencyMs: 12 } })
		);
		expect(design.container.textContent).not.toContain("req/s");
		expect(design.container.textContent).not.toContain("p95");
	});
});

describe("a load run whose assertions failed (#2820)", () => {
	const ASSERTED = {
		...RESULT,
		verdict: "passed" as const,
		assertionsPassed: 10,
		assertionsFailed: 4580,
	};

	it("ends the result line with the failed count, though the error rate is 0.0%", () => {
		renderRow(loadRun({ resultSummary: ASSERTED }));

		expect(
			screen.getByText("485 req/s · p95 42ms · 0.0% errors · 4,580 assertions failed")
		).toBeInTheDocument();
	});

	it("does not draw a passed verdict as the tick, and says not judged in the name", () => {
		const tick = glyphShape(loadRun({ resultSummary: { ...RESULT, verdict: "passed" } }));
		expect(glyphShape(loadRun({ resultSummary: ASSERTED }))).not.toBe(tick);

		renderRow(loadRun({ resultSummary: ASSERTED }));
		expect(
			screen.getByRole("button", { name: /^Open Load test, completed, verdict not judged/ })
		).toBeInTheDocument();
	});
});

describe("a load run's verdict glyph", () => {
	const tick = glyphShape(loadRun());

	it("keeps the tick for a run that passed, which is also the row with no summary", () => {
		expect(glyphShape(loadRun({ resultSummary: { ...RESULT, verdict: "passed" } }))).toBe(tick);
	});

	it("swaps the tick for a failed verdict and for an unjudged run, each its own shape", () => {
		const failed = glyphShape(loadRun({ resultSummary: { ...RESULT, verdict: "failed" } }));
		const unjudged = glyphShape(loadRun({ resultSummary: RESULT }));

		expect(new Set([tick, failed, unjudged]).size).toBe(3);
	});

	it("does not treat a passed verdict with errors as a pass", () => {
		const withErrors = glyphShape(
			loadRun({ resultSummary: { ...RESULT, errorRate: 15.1, verdict: "passed" } })
		);

		expect(withErrors).not.toBe(tick);
	});

	it("leaves a stopped or failed run on its status glyph", () => {
		const summary = { ...RESULT, verdict: "failed" as const };
		const stopped = loadRun({ status: "stopped", resultSummary: summary });
		const failedStatus = loadRun({ status: "failed", resultSummary: summary });

		expect(glyphShape(stopped)).toBe(glyphShape(loadRun({ status: "stopped" })));
		expect(glyphShape(failedStatus)).toBe(glyphShape(loadRun({ status: "failed" })));
	});

	it("says the verdict in words in the row's accessible name", () => {
		renderRow(loadRun({ resultSummary: { ...RESULT, verdict: "failed" } }));

		expect(
			screen.getByRole("button", { name: /^Open Load test, completed, verdict failed/ })
		).toBeInTheDocument();
	});
});

describe("a run's comment", () => {
	it("is a visible line of the row", () => {
		renderRow(
			loadRun({
				summary: { url: "https://api.example.test", comment: "after the cache fix" },
			})
		);

		expect(screen.getByText("after the cache fix")).toBeInTheDocument();
	});

	it("is there for a design run too, and absent when the run has none", () => {
		const design = renderRow(
			loadRun({
				type: "design",
				summary: { url: "https://api.example.test", comment: "smoke" },
			})
		);
		expect(screen.getByText("smoke")).toBeInTheDocument();
		design.unmount();

		const { container } = renderRow(loadRun());
		expect(container.querySelector(".line-clamp-2")).toBeNull();
	});
});
