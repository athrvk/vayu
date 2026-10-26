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
 * A scenario load run's live view draws its sequence (issue #2823): the SEQUENCE
 * chip, the iterations so far and a per-step Executed / Errors table, from the
 * latest gate frame that carries the `scenario` block (plain ticks after it
 * must not blank the panel). Its pooled latency figures say they pool every
 * step. A run without the block renders as it always did.
 *
 * Mutation-check: read the newest tick (`metrics`) instead of the buffer and the
 * non-gate-last case fails; drop `pooled={isSequence}` and the distribution
 * title case fails; render the panel unconditionally and the absent case fails;
 * pass `expectedPerStep` to the live `ExecutedCell` and the no-short-marker case
 * fails.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { LiveScenarioProgress, LoadTestMetrics } from "@/types";
import type { DisplayMetrics } from "../types";
import { LATENCY, PHASES, tick } from "../utils/liveDistributions.testkit";

vi.mock("./charts/uplot", async (importOriginal) => ({
	...(await importOriginal<typeof import("./charts/uplot")>()),
	HdrPercentileChart: () => null,
}));

const MetricsView = (await import("./MetricsView")).default;

function renderView(history: LoadTestMetrics[]) {
	const metrics = history[history.length - 1] as DisplayMetrics;
	return render(
		<TooltipProvider>
			<MetricsView
				metrics={metrics}
				historicalMetrics={history}
				mode="constant_concurrency"
				concurrency={10}
			/>
		</TooltipProvider>
	);
}

const SCENARIO: LiveScenarioProgress = {
	iterations: 12,
	iterationsCompleted: 9,
	iterationsAbandoned: 2,
	stepsExecuted: 30,
	steps: [
		{ index: 0, name: "Log in", executed: 12, errors: 0 },
		{ index: 1, name: "List orders", executed: 10, errors: 3 },
	],
};

const GATE = tick(2, {
	scenario: SCENARIO,
	cumulative_latency: LATENCY,
	cumulative_phases: PHASES,
});

describe("MetricsView sequence panel", () => {
	it("draws the iterations and a row per step from a gate frame", async () => {
		renderView([GATE]);

		expect(await screen.findByText("SEQUENCE")).toBeTruthy();
		expect(screen.getByText("2 steps per iteration")).toBeTruthy();
		expect(screen.getByText("Iterations started:").nextSibling?.textContent).toBe("12");
		expect(screen.getByText("Iterations completed:").nextSibling?.textContent).toBe("9");
		expect(screen.getByText("Iterations abandoned:").nextSibling?.textContent).toBe("2");

		const logIn = screen
			.getByRole("rowheader", { name: /Log in/ })
			.closest("tr") as HTMLElement;
		expect(
			within(logIn)
				.getAllByRole("cell")
				.map((c) => c.textContent)
		).toEqual(["12", "0"]);
		const list = screen
			.getByRole("rowheader", { name: /List orders/ })
			.closest("tr") as HTMLElement;
		expect(
			within(list)
				.getAllByRole("cell")
				.map((c) => c.textContent)
		).toEqual(["10", "3"]);
	});

	it("keeps the panel when plain ticks follow the gate frame", async () => {
		renderView([GATE, tick(2.1), tick(2.2)]);

		expect(await screen.findByText("SEQUENCE")).toBeTruthy();
		expect(screen.getByRole("rowheader", { name: /List orders/ })).toBeTruthy();
	});

	it("shows no short marker, since a step in flight is always behind the one before it", async () => {
		renderView([GATE]);

		await screen.findByText("SEQUENCE");
		expect(screen.queryByText(/short/)).toBeNull();
	});

	it("leaves abandoned out while it is zero", async () => {
		renderView([tick(2, { scenario: { ...SCENARIO, iterationsAbandoned: 0 } })]);

		await screen.findByText("SEQUENCE");
		expect(screen.queryByText("Iterations abandoned:")).toBeNull();
	});

	it("says the latency figures pool every step", async () => {
		renderView([GATE, tick(2.1)]);

		expect(await screen.findByText("All steps pooled")).toBeTruthy();
		expect(
			screen.getByRole("heading", { name: /Latency distribution \(all steps\)/ })
		).toBeTruthy();
	});
});

describe("MetricsView without a sequence block", () => {
	it("renders no panel and leaves the latency figures unqualified", async () => {
		renderView([tick(2, { cumulative_latency: LATENCY, cumulative_phases: PHASES })]);

		expect(await screen.findByRole("heading", { name: /^Latency distribution/ })).toBeTruthy();
		expect(screen.queryByText("SEQUENCE")).toBeNull();
		expect(screen.queryByText(/pooled/i)).toBeNull();
		expect(screen.queryByText(/all steps/i)).toBeNull();
	});
});
