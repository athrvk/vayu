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
 * "Copy for agent" on a budget's verdict (#2047): an icon button per check,
 * naming the budget by its engine key and the run that was judged. The limit
 * and the measurement are on screen beside it and never in the line.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useToastStore } from "@/stores";
import { ThresholdVerdict } from "./ThresholdVerdict";
import type { RunReport } from "@/types/domain";

type Verdict = NonNullable<RunReport["thresholdValidation"]>;

// Odd enough that neither can appear in a line by accident.
const LIMIT = 4817.5;
const ACTUAL = 9263.25;

const VERDICT: Verdict = {
	checks: [
		{ metric: "latencyP95Ms", limit: LIMIT, actual: ACTUAL, passed: false },
		{ metric: "custom.checkout_ttfb.p99", limit: LIMIT, actual: ACTUAL, passed: false },
		{ metric: "maxErrorRatePct", limit: LIMIT, passed: false, evaluated: false },
	],
	passed: 0,
	failed: 3,
	verdict: "failed",
};

const writeText = vi.fn();

beforeEach(() => {
	cleanup();
	writeText.mockReset().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	useToastStore.setState({ toasts: [] });
});

const copyButton = (name: string) => screen.queryByRole("button", { name });

/** The glyph a button shows now; `IconSwap` keeps the other one invisible beside it. */
function liveGlyph(button: HTMLElement): string {
	return button.querySelector(".enter-fade svg")?.getAttribute("class") ?? "";
}

describe("Copy for agent on a threshold check", () => {
	it.each([
		["p95 latency", "latencyP95Ms"],
		["custom.checkout_ttfb.p99", "custom.checkout_ttfb.p99"],
		["Error rate", "maxErrorRatePct"],
	])("copies %s under the engine's key, of the run", async (label, key) => {
		render(<ThresholdVerdict verdict={VERDICT} runId="run_9" />);

		fireEvent.click(copyButton(`Copy ${label} budget for agent`)!);

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith(`Vayu threshold "${key}" of run (run_9)`);
	});

	it("swaps the glyph to a check and raises no toast", async () => {
		render(<ThresholdVerdict verdict={VERDICT} runId="run_9" />);
		const button = copyButton("Copy p95 latency budget for agent")!;
		expect(liveGlyph(button)).toContain("lucide-copy");

		fireEvent.click(button);

		await waitFor(() => expect(liveGlyph(button)).toContain("lucide-check"));
		expect(useToastStore.getState().toasts).toEqual([]);
	});

	it("keeps the limit and the measurement off the clipboard", async () => {
		render(<ThresholdVerdict verdict={VERDICT} runId="run_9" />);

		for (const button of screen.getAllByRole("button", { name: /budget for agent$/ })) {
			fireEvent.click(button);
		}

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(3));
		for (const [line] of writeText.mock.calls) {
			expect(line).not.toMatch(/4817|9263/);
		}
		// They are on screen, so the absence above is the formatter's doing.
		expect(screen.getAllByText(/4817\.50/).length).toBeGreaterThan(0);
	});

	it("is absent without a run id", () => {
		render(<ThresholdVerdict verdict={VERDICT} />);

		expect(screen.getByText("Failed")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /for agent$/ })).toBeNull();
	});
});
