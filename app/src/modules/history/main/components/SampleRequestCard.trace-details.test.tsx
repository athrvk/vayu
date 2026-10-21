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
 * What a stored sample's trace says beyond its timing, on the card History
 * renders for a finished run: the data row it bound (#449), the per-test
 * failures (#111), the error type and the slow-request callout. The engine
 * writes each; this is the layer that has to read it.
 *
 * Mutation-check: delete the `dataRowIndex` block, the `failures` block, the
 * `error_type` block of `SampleTraceDetails.tsx` or the `isSlow` callout of
 * `SampleRequestCard.tsx` and the matching case fails.
 */

import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import SampleRequestCard from "./SampleRequestCard";
import type { SampleResult } from "../../types";
import type { RunResultTrace } from "@/types";

function renderExpanded(trace: RunResultTrace, overrides: Partial<SampleResult> = {}) {
	const sample: SampleResult = {
		timestamp: 1_700_000_000_000,
		statusCode: 500,
		latencyMs: 12,
		error: "server error",
		trace,
		...overrides,
	};
	return render(<SampleRequestCard sample={sample} index={0} isExpanded onToggle={() => {}} />);
}

describe("SampleRequestCard data row (#449)", () => {
	it("names the row the sample was bound to", () => {
		renderExpanded({ dataRowIndex: 7, totalMs: 12 });

		expect(screen.getByText("Data row:").parentElement?.textContent).toMatch(/Data row:\s*7$/);
	});

	it("shows row 0 rather than treating it as absent", () => {
		// A falsy check would hide the first row of every data file.
		renderExpanded({ dataRowIndex: 0, totalMs: 12 });

		expect(screen.getByText("Data row:").parentElement?.textContent).toMatch(/Data row:\s*0$/);
	});

	it("says nothing about rows for a run that had none", () => {
		renderExpanded({ totalMs: 12 });

		expect(screen.queryByText(/Data row:/)).toBeNull();
	});
});

describe("SampleRequestCard per-test failures (#111)", () => {
	const failures = [
		"status is 200: expected 404 to equal 200",
		"body has token: expected undefined to exist",
	];

	it("lists each failing test's message under the failed count", () => {
		renderExpanded(
			{ failures, totalFailed: 2, totalPassed: 3 },
			{ statusCode: 0, error: "Script validation failures" }
		);

		for (const message of failures) expect(screen.getByText(message)).toBeInTheDocument();
		expect(screen.getByText(/Failed tests/).textContent).toMatch(/Failed tests\s*\(2\)/);
	});

	it("draws each failure as a blocking Callout, not a hand-rolled status box (#2317)", () => {
		renderExpanded({ failures });

		for (const message of failures) {
			const box = screen.getByText(message).closest(".border");
			expect(box).toHaveClass("border-destructive/40");
			expect(box?.className).not.toMatch(/status-/);
			expect(box?.querySelector("svg")).not.toBeNull();
		}
	});

	it("omits the count when the trace carries none", () => {
		renderExpanded({ failures });

		expect(screen.getByText(/Failed tests/).textContent).not.toMatch(/\(/);
	});

	it("renders no Failed tests block when the trace carries no failures", () => {
		renderExpanded({ failures: [] });

		expect(screen.queryByText(/Failed tests/)).toBeNull();
	});
});

describe("SampleRequestCard error type", () => {
	it("prints the engine's error type", () => {
		renderExpanded({ error_type: "ConnectionError" }, { error: "connection refused" });

		expect(screen.getByText("Error type:").parentElement?.textContent).toMatch(
			/Error type:\s*ConnectionError$/
		);
	});

	it("prints no Error type row when the trace has none", () => {
		renderExpanded({ totalMs: 12 });

		expect(screen.queryByText(/Error type:/)).toBeNull();
	});
});

describe("SampleRequestCard slow-request callout", () => {
	it("states the sample's time against the threshold", () => {
		renderExpanded({ isSlow: true, totalMs: 612.34, thresholdMs: 500 }, { statusCode: 200 });

		const title = screen.getByText("Slow request");
		expect(title.parentElement?.textContent).toContain("612ms");
		expect(title.parentElement?.textContent).toContain("(threshold: 500ms)");
	});

	it("prints no elapsed time, not a measured 0, when the trace carries none", () => {
		renderExpanded({ isSlow: true, thresholdMs: 500 }, { statusCode: 200 });

		const text = screen.getByText("Slow request").parentElement?.textContent ?? "";
		expect(text).toContain("(threshold: 500ms)");
		expect(text.match(/ms/g)).toHaveLength(1);
	});

	it("leaves the threshold out when the trace does not carry one", () => {
		renderExpanded({ isSlow: true, totalMs: 612.34 }, { statusCode: 200 });

		expect(screen.getByText("Slow request").parentElement?.textContent).not.toContain(
			"threshold"
		);
	});

	it("shows no callout for a sample under the threshold", () => {
		renderExpanded({ isSlow: false, totalMs: 12, thresholdMs: 500 }, { statusCode: 200 });

		expect(screen.queryByText("Slow request")).toBeNull();
	});
});
