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
 * Issue #76 guard: every renderer of the five network phases derives its list
 * from `TIMING_PHASES`.
 *
 * There are five of them - the request-builder's timing tab, the dashboard's
 * run-level averages card, the dashboard's timing waterfall, the dashboard's
 * per-sample tiles, and the history sample card - and each used to declare its
 * own copy of the list. Two had already drifted: the waterfall painted TTFB
 * with `--primary` and Download with `--success` (the tab had the same bug and
 * fixed it, in its own copy), and the waterfall carried private tooltip strings
 * that `phase-tips.ts` was written to replace.
 *
 * **Asserting that the current five render is not a guard** - a renderer with a
 * hardcoded list of the same five passes that. So the descriptor is mocked with
 * a sixth phase and each renderer is asked to show it. A renderer wired to the
 * shared list picks it up; a renderer that went back to a local one cannot.
 * That is the mutation check: revert any single call site to its own array and
 * only that call site's case here fails.
 *
 * The mock re-implements the two selectors over the extended list, so this file
 * does not test them. `describe("selectors")` at the bottom exercises the real
 * ones, unmocked, through `importActual`.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { TooltipProvider } from "@/components/ui";
import type { RunReport } from "@/types";
import { withQueryClient } from "@/test/query-wrapper";

/** The synthetic sixth phase. Nothing in the app declares it. */
const PROBE = {
	key: "probe",
	label: "Probe",
	longLabel: "Probe Long",
	cssVar: "--chart-2",
	tip: "A phase that exists only in this test.",
	traceKey: "probeMs",
	averageKey: "avgProbeMs",
};

vi.mock("@/components/shared/response-viewer/timing-phases", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/components/shared/response-viewer/timing-phases")>();
	const TIMING_PHASES = [
		...actual.TIMING_PHASES,
		PROBE as unknown as (typeof actual.TIMING_PHASES)[number],
	];

	type Source = Record<string, number | undefined> | null | undefined;

	return {
		...actual,
		TIMING_PHASES,
		phasesFromTrace: (source: Source) =>
			TIMING_PHASES.map((p) => ({ ...p, value: source?.[p.traceKey] })).filter(
				(p) => p.value !== undefined
			),
		phasesFromAverages: (source: Source) =>
			TIMING_PHASES.map((p) => ({ ...p, value: source?.[p.averageKey] })),
	};
});

// ResponseBody mounts Monaco via CodeEditor; stub it so an expanded sample
// renders in jsdom.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

const withTooltips = (ui: React.ReactNode) => render(<TooltipProvider>{ui}</TooltipProvider>);

/** A trace reporting all five real phases plus the probe. */
const trace = {
	dnsMs: 1,
	connectMs: 2,
	tlsMs: 3,
	firstByteMs: 4,
	downloadMs: 5,
	probeMs: 6,
};

/** Run averages, same shape on the `avg*` side. */
const averages = {
	avgDnsMs: 1,
	avgConnectMs: 2,
	avgTlsMs: 3,
	avgFirstByteMs: 4,
	avgDownloadMs: 5,
	avgProbeMs: 6,
};

function reportWithSample(): RunReport {
	return {
		summary: {
			totalRequests: 1,
			successfulRequests: 1,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 1,
			avgRps: 1,
		},
		latency: { min: 5, max: 5, avg: 5, p50: 5, p90: 5, p95: 5, p99: 5 },
		statusCodes: {},
		errors: { total: 0, withDetails: 0, types: {} },
		timingBreakdown: averages as unknown as RunReport["timingBreakdown"],
		results: [
			{
				timestamp: 1_700_000_000_000,
				statusCode: 200,
				statusText: "OK",
				latencyMs: 5,
				trace: trace as unknown as NonNullable<RunReport["results"]>[number]["trace"],
			},
		],
	} as RunReport;
}

describe("every timing renderer reads TIMING_PHASES (#76)", () => {
	it("the request-builder timing tab", async () => {
		const ResponseTimingTab = (
			await import("@/modules/request-builder/components/ResponseViewer/ResponseTimingTab")
		).default;

		withTooltips(
			<ResponseTimingTab
				timing={{ totalMs: 21, ...trace } as unknown as import("@/types").ResponseTiming}
			/>
		);

		expect(screen.getByText(PROBE.label)).toBeInTheDocument();
	});

	it("the dashboard timing waterfall", async () => {
		const { TimingWaterfall } =
			await import("@/modules/dashboard/components/charts/TimingWaterfall");

		withTooltips(<TimingWaterfall report={reportWithSample()} />);

		expect(screen.getByText(PROBE.label)).toBeInTheDocument();
	});

	it("the dashboard run-level averages card (which reads longLabel)", async () => {
		const RequestResponseView = (
			await import("@/modules/dashboard/components/RequestResponseView")
		).default;

		withTooltips(withQueryClient(<RequestResponseView report={reportWithSample()} />));

		expect(screen.getByText(PROBE.longLabel)).toBeInTheDocument();
	});

	it("the dashboard per-sample tiles", async () => {
		const RequestResponseView = (
			await import("@/modules/dashboard/components/RequestResponseView")
		).default;

		withTooltips(withQueryClient(<RequestResponseView report={reportWithSample()} />));
		fireEvent.click(screen.getByRole("button", { name: /200 OK/ }));

		// The averages card prints `longLabel`, the tiles print `label` - so a
		// match on the short one can only have come from the tiles.
		expect(screen.getByText(PROBE.label)).toBeInTheDocument();
	});

	it("the history sample card", async () => {
		const SampleRequestCard = (
			await import("@/modules/history/main/components/SampleRequestCard")
		).default;

		withTooltips(
			<SampleRequestCard
				sample={
					{
						timestamp: 1_700_000_000_000,
						statusCode: 200,
						latencyMs: 5,
						trace,
					} as unknown as import("@/modules/history/types").SampleResult
				}
				index={0}
				isExpanded
				onToggle={() => {}}
			/>
		);

		expect(screen.getByText(PROBE.label)).toBeInTheDocument();
	});
});

describe("phase descriptor", () => {
	it("paints no phase with an accent-tracking token", async () => {
		const { TIMING_PHASES } = await vi.importActual<
			typeof import("@/components/shared/response-viewer/timing-phases")
		>("@/components/shared/response-viewer/timing-phases");

		// `--primary` and `--chart-1` follow the user's chosen accent, so either
		// can land on a neighbouring phase's hue. Under the green scheme
		// `--primary` and `--success` were three points of lightness apart, and
		// two of the five phases rendered as one colour.
		const accentTracking = ["--primary", "--primary-fill", "--chart-1"];
		for (const phase of TIMING_PHASES) {
			expect(accentTracking).not.toContain(phase.cssVar);
		}
	});

	it("gives every phase a distinct hue", async () => {
		const { TIMING_PHASES } = await vi.importActual<
			typeof import("@/components/shared/response-viewer/timing-phases")
		>("@/components/shared/response-viewer/timing-phases");

		const hues = TIMING_PHASES.map((p) => p.cssVar);
		expect(new Set(hues).size).toBe(TIMING_PHASES.length);
	});

	it("sources every tip from PHASE_TIPS", async () => {
		const { TIMING_PHASES } = await vi.importActual<
			typeof import("@/components/shared/response-viewer/timing-phases")
		>("@/components/shared/response-viewer/timing-phases");
		const { PHASE_TIPS } = await vi.importActual<
			typeof import("@/components/shared/response-viewer/phase-tips")
		>("@/components/shared/response-viewer/phase-tips");

		// The waterfall's private copies were longer than these and drifting.
		for (const phase of TIMING_PHASES) {
			expect(phase.tip).toBe(PHASE_TIPS[phase.key as keyof typeof PHASE_TIPS]);
		}
	});
});

describe("selectors", () => {
	it("drops phases a trace did not report, and keeps wire order", async () => {
		const { phasesFromTrace } = await vi.importActual<
			typeof import("@/components/shared/response-viewer/timing-phases")
		>("@/components/shared/response-viewer/timing-phases");

		// No TLS: plain HTTP. That is not the same statement as "0ms handshake".
		const resolved = phasesFromTrace({ dnsMs: 1, connectMs: 2, firstByteMs: 4 });
		expect(resolved.map((p) => p.key)).toEqual(["dns", "connect", "ttfb"]);
		expect(resolved.map((p) => p.value)).toEqual([1, 2, 4]);
	});

	it("keeps a reported zero, which is not the same as absent", async () => {
		const { phasesFromTrace } = await vi.importActual<
			typeof import("@/components/shared/response-viewer/timing-phases")
		>("@/components/shared/response-viewer/timing-phases");

		expect(phasesFromTrace({ tlsMs: 0 }).map((p) => p.key)).toEqual(["tls"]);
	});

	it("reads averages off the avg* fields and never filters", async () => {
		const { phasesFromAverages } = await vi.importActual<
			typeof import("@/components/shared/response-viewer/timing-phases")
		>("@/components/shared/response-viewer/timing-phases");

		// A fixed five rows keeps the card from resizing when a live run starts
		// reporting; the missing ones render "-".
		const resolved = phasesFromAverages({ avgTlsMs: 3 });
		expect(resolved).toHaveLength(5);
		expect(resolved.find((p) => p.key === "tls")?.value).toBe(3);
		expect(resolved.find((p) => p.key === "dns")?.value).toBeUndefined();
	});

	it("handles a null source", async () => {
		const { phasesFromTrace, phasesFromAverages } = await vi.importActual<
			typeof import("@/components/shared/response-viewer/timing-phases")
		>("@/components/shared/response-viewer/timing-phases");

		expect(phasesFromTrace(null)).toEqual([]);
		expect(phasesFromAverages(null).every((p) => p.value === undefined)).toBe(true);
	});
});
