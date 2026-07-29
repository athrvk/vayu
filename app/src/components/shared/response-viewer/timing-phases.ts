/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The five network phases - DNS -> Connect -> TLS -> TTFB -> Download - as one
 * ordered descriptor list.
 *
 * Five components render these same five numbers: the request-builder's timing
 * tab, the dashboard's per-sample tiles, the dashboard's run-level averages
 * card, the dashboard's timing waterfall, and the history sample card. Each
 * one used to declare its own copy of the list - the label, the colour, the
 * field it reads, and (until `phase-tips.ts`) the tooltip. Adding a phase meant
 * finding all five; nothing pointed you at the other four.
 *
 * Two things had already drifted by the time this file was written, both in
 * ways a reader of any single file could not see:
 *
 *   - **`TimingWaterfall` still paints TTFB with `--primary` and Download with
 *     `--success`.** `ResponseTimingTab`'s header comment describes fixing
 *     exactly that ("they are `--chart-3` and `--chart-6` now") - the fix
 *     reached one of the two colour-encoding renderers. `--primary` tracks the
 *     user's accent, which the design system forbids for a chart series
 *     precisely because it collides with a neighbouring one; the guard that
 *     enforces it (`charts/uplot/status-code-series.test.ts`) reads only the
 *     `uplot/` directory, and the waterfall lives one level up.
 *   - **`TimingWaterfall` carries its own longer tip strings**, written before
 *     `phase-tips.ts` existed and never migrated - so the file whose docstring
 *     says these five sentences now live in one place was describing four
 *     renderers out of five.
 *
 * Colour is an *encoding* in the two chart-like renderers (waterfall bars,
 * timeline segments) and decoration in the tiles, so `cssVar` below is the
 * single source for the former and the tiles stay neutral. Every phase is a
 * fixed categorical hue - never `--primary` or `--chart-1`, both of which
 * follow the accent.
 *
 * Add a phase here and all five renderers pick it up.
 */

import { PHASE_TIPS } from "./phase-tips";

export type TimingPhaseKey = "dns" | "connect" | "tls" | "ttfb" | "download";

/** Field name on a single request's trace / `ResponseTiming`. */
export type TimingPhaseTraceKey = "dnsMs" | "connectMs" | "tlsMs" | "firstByteMs" | "downloadMs";

/** Field name on a run report's `timingBreakdown` (per-run averages). */
export type TimingPhaseAverageKey =
	| "avgDnsMs"
	| "avgConnectMs"
	| "avgTlsMs"
	| "avgFirstByteMs"
	| "avgDownloadMs";

export interface TimingPhase {
	key: TimingPhaseKey;
	/** What tiles, legend rows and waterfall rows print. */
	label: string;
	/**
	 * Spelled-out label for the run-level averages card, which has the width for
	 * it and has always read "First Byte" where the dense renderers read "TTFB".
	 */
	longLabel: string;
	/**
	 * Fixed categorical hue for the renderers where colour *is* the encoding.
	 * Never an accent-tracking token - see the file header.
	 */
	cssVar: string;
	tip: string;
	traceKey: TimingPhaseTraceKey;
	averageKey: TimingPhaseAverageKey;
}

/** The phases in wire order. This ordering is the render order everywhere. */
export const TIMING_PHASES: readonly TimingPhase[] = [
	{
		key: "dns",
		label: "DNS",
		longLabel: "DNS",
		cssVar: "--chart-2",
		tip: PHASE_TIPS.dns,
		traceKey: "dnsMs",
		averageKey: "avgDnsMs",
	},
	{
		key: "connect",
		label: "Connect",
		longLabel: "Connect",
		cssVar: "--chart-4",
		tip: PHASE_TIPS.connect,
		traceKey: "connectMs",
		averageKey: "avgConnectMs",
	},
	{
		key: "tls",
		label: "TLS",
		longLabel: "TLS",
		cssVar: "--chart-5",
		tip: PHASE_TIPS.tls,
		traceKey: "tlsMs",
		averageKey: "avgTlsMs",
	},
	{
		key: "ttfb",
		label: "TTFB",
		longLabel: "First Byte",
		cssVar: "--chart-3",
		tip: PHASE_TIPS.ttfb,
		traceKey: "firstByteMs",
		averageKey: "avgFirstByteMs",
	},
	{
		key: "download",
		label: "Download",
		longLabel: "Download",
		cssVar: "--chart-6",
		tip: PHASE_TIPS.download,
		traceKey: "downloadMs",
		averageKey: "avgDownloadMs",
	},
];

/** `hsl(var(--chart-n))` - the form every consumer wants for an inline style. */
export function phaseColor(phase: TimingPhase): string {
	return `hsl(var(${phase.cssVar}))`;
}

/** Any object carrying per-request phase fields: a run trace or a `ResponseTiming`. */
export type TimingPhaseSource = Partial<Record<TimingPhaseTraceKey, number | undefined>>;

/** Any object carrying per-run averages: a report's `timingBreakdown`. */
export type TimingAverageSource = Partial<Record<TimingPhaseAverageKey, number | undefined>>;

/** A phase paired with the number a particular source holds for it. */
export interface ResolvedTimingPhase extends TimingPhase {
	value: number;
}

/** As above, but the value may be missing - for renderers with fixed-height rows. */
export interface MaybeResolvedTimingPhase extends TimingPhase {
	value: number | undefined;
}

/**
 * The phases a single request actually reported, in wire order.
 *
 * Absent phases are dropped rather than rendered as zero: a trace with no TLS
 * is plain HTTP, which is not the same statement as "the TLS handshake took
 * 0ms". A reported zero is kept, for the same reason read the other way.
 */
export function phasesFromTrace(
	source: TimingPhaseSource | null | undefined
): ResolvedTimingPhase[] {
	return TIMING_PHASES.map((phase) => ({ ...phase, value: source?.[phase.traceKey] })).filter(
		(phase): phase is ResolvedTimingPhase => phase.value !== undefined
	);
}

/**
 * All five phases from a run report's averages.
 *
 * Unlike a trace, this never filters: the averages card and the waterfall both
 * render a fixed five rows so the card does not resize when a run starts
 * reporting, and show "-" for a value that is not there yet.
 */
export function phasesFromAverages(
	source: TimingAverageSource | null | undefined
): MaybeResolvedTimingPhase[] {
	return TIMING_PHASES.map((phase) => ({ ...phase, value: source?.[phase.averageKey] }));
}
