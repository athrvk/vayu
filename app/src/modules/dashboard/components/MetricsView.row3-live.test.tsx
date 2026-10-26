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
 * Row 3 of the live view draws the run so far (issue #2782): History's HDR
 * chart and timing waterfall, fed from the latest gate frame in the buffer.
 * The newest tick is usually not a gate frame, so these cases put plain ticks
 * after it and assert the cards keep their data.
 *
 * The HDR plot is a uPlot canvas, stubbed to a marker that carries the report
 * it was handed.
 *
 * Mutation-check: feed the waterfall `null`, or one phase's bar another
 * phase's mean, and the waterfall case fails; map a phase's p99 from another
 * key in `utils/liveDistributions.ts` and the percentile-table case fails; drop
 * the completions caption and the count case fails; read the newest tick
 * (`metrics`) instead of the buffer and the non-gate-last case fails.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useClientSettingsStore, useDashboardStore } from "@/stores";
import type { LoadTestMetrics, RunReport } from "@/types";
import type { DisplayMetrics } from "../types";
import { LATENCY, PHASES, tick } from "../utils/liveDistributions.testkit";

vi.mock("./charts/uplot", async (importOriginal) => ({
	...(await importOriginal<typeof import("./charts/uplot")>()),
	HdrPercentileChart: ({
		report,
		sloMs,
	}: {
		report: Pick<RunReport, "latency">;
		sloMs?: number;
	}) => (
		<div data-testid="hdr-plot" data-slo-ms={sloMs}>
			{JSON.stringify(report.latency)}
		</div>
	),
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

const card = (title: RegExp) =>
	screen.getByRole("heading", { name: title }).closest("div.surface-card") as HTMLElement;

// Its mean differs from the plain ticks' (the kit's 7), so a footer that read
// the newest tick instead of the gate frame would not match the curve beside it.
const GATE = tick(2, {
	cumulative_latency: LATENCY,
	cumulative_phases: PHASES,
	avg_latency_ms: 9.5,
});

describe("MetricsView latency distribution card", () => {
	it("draws the HDR plot from the latest gate frame, mean from that frame", () => {
		renderView([tick(1.9), GATE, tick(2.1), tick(2.2)]);

		const plot = screen.getByTestId("hdr-plot");
		expect(JSON.parse(plot.textContent ?? "")).toEqual({
			min: 1,
			max: 120,
			avg: 9.5,
			p50: 5,
			p75: 8,
			p90: 12,
			p95: 20,
			p99: 40,
			p999: 90,
		});
	});

	// The plot's markers are judged against the run's own p99 line (#2939), never
	// the Settings SLO. Mutation check: fall back to the setting in `MetricsView`
	// and the second case fails.
	it("passes the run's p99 budget to the plot", () => {
		useClientSettingsStore.setState({ sloThresholdMs: 250 });
		useDashboardStore.getState().startRun("r", { latencyP99Ms: 120 });
		try {
			renderView([GATE, tick(2.1)]);

			expect(screen.getByTestId("hdr-plot")).toHaveAttribute("data-slo-ms", "120");
		} finally {
			useDashboardStore.getState().startRun("r");
		}
	});

	it("passes no SLO to the plot for a run that declared none, whatever the setting", () => {
		useClientSettingsStore.setState({ sloThresholdMs: 250 });
		renderView([GATE, tick(2.1)]);

		expect(screen.getByTestId("hdr-plot")).not.toHaveAttribute("data-slo-ms");
	});

	// A capacity run's plot judges its p95/p99 markers against the run's own SLO
	// (#2816). Mutation check: read the setting unconditionally in
	// `LiveDistributionRow` and this fails.
	it("passes a capacity run's own SLO to the plot, not the setting", () => {
		useClientSettingsStore.setState({ sloThresholdMs: 250 });
		useDashboardStore.getState().startRun("r", { mode: "capacity", sloMs: 50 });
		try {
			renderView([GATE, tick(2.1)]);

			expect(screen.getByTestId("hdr-plot")).toHaveAttribute("data-slo-ms", "50");
		} finally {
			useDashboardStore.getState().startRun("r");
		}
	});

	it("prints the footer figures, none of them a dash", () => {
		renderView([GATE, tick(2.1)]);

		const footer = within(card(/Latency distribution/))
			.getByText("min")
			.closest("div") as HTMLElement;
		expect(footer.textContent).toMatch(/min\s*1/);
		expect(footer.textContent).toMatch(/mean\s*9\.5/);
		expect(footer.textContent).toMatch(/p99\s*40/);
		expect(footer.textContent).toMatch(/max\s*120/);
		expect(footer.textContent).not.toContain("-");
	});

	it("counts the completions behind the curve, singular for one", () => {
		const { unmount } = renderView([GATE, tick(2.1)]);
		expect(
			within(card(/Latency distribution/)).getByText("600 completions so far")
		).toBeVisible();
		unmount();

		renderView([
			tick(2, { cumulative_latency: { ...LATENCY, count: 1 }, cumulative_phases: PHASES }),
		]);
		expect(within(card(/Latency distribution/)).getByText("1 completion so far")).toBeVisible();
	});

	it("groups the count by locale for a long run", () => {
		renderView([tick(2, { cumulative_latency: { ...LATENCY, count: 1234567 } })]);

		expect(
			within(card(/Latency distribution/)).getByText(
				`${(1234567).toLocaleString()} completions so far`
			)
		).toBeVisible();
	});

	it("keeps its data when the newest tick is not a gate frame", () => {
		renderView([GATE, tick(2.1), tick(2.2), tick(2.3)]);

		expect(screen.getByTestId("hdr-plot")).toBeInTheDocument();
		expect(screen.queryByText("Waiting for the first response")).toBeNull();
	});
});

describe("MetricsView request timing card", () => {
	it("draws the waterfall from the gate frame's phase means", () => {
		renderView([GATE, tick(2.1)]);

		const timing = card(/Avg request timing/);
		// Each bar its own phase's mean, so a phase fed another's value shows.
		const bars = { DNS: "0.10", Connect: "0.20", TLS: "0.30", TTFB: "3.10", Download: "0.40" };
		for (const [label, value] of Object.entries(bars)) {
			// The percentile table repeats each label below the waterfall.
			const row = within(timing).getAllByText(label)[0].parentElement;
			expect(row?.textContent, label).toContain(`${value}ms`);
		}
		// 0.1 + 0.2 + 0.3 + 3.1 + 0.4 = 4.1 ms, so the total is not the empty "-".
		expect(within(timing).getByText("Avg total").parentElement?.textContent).toContain("4.1");
		expect(within(timing).queryByText("Waiting for the first response")).toBeNull();
	});

	it("lists each phase's p50, p95, p99 and max under the waterfall", () => {
		renderView([GATE, tick(2.1)]);

		const timing = card(/Avg request timing/);
		for (const header of ["p50", "p95", "p99", "max"]) {
			expect(within(timing).getByText(header)).toBeInTheDocument();
		}
		// One row per phase, each figure its own key's: the kit gives all four
		// of a phase different values, so a column read from its neighbour shows.
		const table = {
			DNS: ["0.05", "0.20", "0.30", "0.90"],
			Connect: ["0.15", "0.40", "0.60", "1.80"],
			TLS: ["0.25", "0.70", "1.20", "4.50"],
			TTFB: ["2.50", "6.50", "8.50", "21.0"],
			Download: ["0.35", "0.80", "1.10", "2.70"],
		};
		for (const [label, figures] of Object.entries(table)) {
			const row = within(timing).getAllByText(label)[1].parentElement;
			expect(row?.textContent, label).toBe(label + figures.map((f) => `${f}ms`).join(""));
		}
		expect(within(timing).getByText("Over every completion (600).")).toBeInTheDocument();
	});

	it("says phase timing is off when the gate frame carries latency but no phases", () => {
		renderView([tick(2, { cumulative_latency: LATENCY }), tick(2.1)]);

		const timing = card(/Avg request timing/);
		expect(within(timing).getByText("Phase timing is off for this run")).toBeInTheDocument();
		expect(within(timing).queryByText("Avg total")).toBeNull();
		expect(within(timing).queryByText("TTFB")).toBeNull();
		expect(within(timing).queryByText("p99")).toBeNull();
		expect(within(timing).queryByText(/Over every completion/)).toBeNull();
	});
});

describe("MetricsView before the first completion", () => {
	it("holds one waiting line per card, with no plot and no bars", () => {
		const first = tick(1, { cumulative_latency: null, cumulative_phases: null });
		renderView([first, tick(1.1)]);

		expect(screen.getAllByText("Waiting for the first response")).toHaveLength(2);
		expect(screen.queryByTestId("hdr-plot")).toBeNull();
		expect(screen.queryByText("Avg total")).toBeNull();
		expect(screen.queryByText(/Over every completion/)).toBeNull();
		expect(screen.queryByText(/completions? so far/)).toBeNull();
	});

	it("waits as well before the first gate frame arrives", () => {
		renderView([tick(0.1), tick(0.2)]);

		expect(screen.getAllByText("Waiting for the first response")).toHaveLength(2);
	});
});
