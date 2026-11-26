/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The five network phases (DNS -> Connect -> TLS -> TTFB -> Download) as one ordered descriptor
 * list, read by the request builder's timing tab, the dashboard's per-sample tiles, run-level
 * averages card and timing waterfall, and the history sample card: a phase added here reaches all
 * five. Colour *encodes* the phase in the chart-like renderers (waterfall bars, timeline segments)
 * and would be decoration in the tiles, so `cssVar` is the former's single source and the tiles
 * stay neutral. Every phase is a fixed categorical hue, never `--primary` or `--chart-1`, which
 * follow the accent.
 */

import { PHASE_TIPS } from "./phase-tips";

export type TimingPhaseKey = "dns" | "connect" | "tls" | "ttfb" | "download";

/** Field name on a single request's trace / `ResponseTiming`. */
export type TimingPhaseTraceKey = "dnsMs" | "connectMs" | "tlsMs" | "firstByteMs" | "downloadMs";

/** Field name on a run report's `timingBreakdown` (per-run averages). */
export type TimingPhaseAverageKey =
	"avgDnsMs" | "avgConnectMs" | "avgTlsMs" | "avgFirstByteMs" | "avgDownloadMs";

/**
 * The key on a report's `timingBreakdown.phases` (per-run percentiles), spelled apart from
 * {@link TimingPhaseKey}: the engine writes the wire name, TTFB's being `firstByte`. Both on the
 * descriptor, so no renderer reaches for `phases[phase.key]` and finds nothing for TTFB.
 */
export type TimingPhasePercentileKey = "dns" | "connect" | "tls" | "firstByte" | "download";

export interface TimingPhase {
	key: TimingPhaseKey;
	/** What tiles, legend rows and waterfall rows print. */
	label: string;
	/**
	 * The spelled-out label for the run-level averages card, which has the width and reads "First
	 * Byte" where dense renderers read "TTFB".
	 */
	longLabel: string;
	/**
	 * A fixed categorical hue for renderers where colour *is* the encoding, never an
	 * accent-tracking token (see the header).
	 */
	cssVar: string;
	tip: string;
	traceKey: TimingPhaseTraceKey;
	averageKey: TimingPhaseAverageKey;
	percentileKey: TimingPhasePercentileKey;
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
		percentileKey: "dns",
	},
	{
		key: "connect",
		label: "Connect",
		longLabel: "Connect",
		cssVar: "--chart-4",
		tip: PHASE_TIPS.connect,
		traceKey: "connectMs",
		averageKey: "avgConnectMs",
		percentileKey: "connect",
	},
	{
		key: "tls",
		label: "TLS",
		longLabel: "TLS",
		cssVar: "--chart-5",
		tip: PHASE_TIPS.tls,
		traceKey: "tlsMs",
		averageKey: "avgTlsMs",
		percentileKey: "tls",
	},
	{
		key: "ttfb",
		label: "TTFB",
		longLabel: "First byte",
		cssVar: "--chart-3",
		tip: PHASE_TIPS.ttfb,
		traceKey: "firstByteMs",
		averageKey: "avgFirstByteMs",
		percentileKey: "firstByte",
	},
	{
		key: "download",
		label: "Download",
		longLabel: "Download",
		cssVar: "--chart-6",
		tip: PHASE_TIPS.download,
		traceKey: "downloadMs",
		averageKey: "avgDownloadMs",
		percentileKey: "download",
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
 * The phases one request reported, in wire order. Absent phases are dropped, not zeroed: a trace
 * with no TLS is plain HTTP, not "the handshake took 0ms"; a reported zero is kept, for the same
 * reason.
 */
export function phasesFromTrace(
	source: TimingPhaseSource | null | undefined
): ResolvedTimingPhase[] {
	return TIMING_PHASES.map((phase) => ({ ...phase, value: source?.[phase.traceKey] })).filter(
		(phase): phase is ResolvedTimingPhase => phase.value !== undefined
	);
}

/**
 * All five phases from a report's averages, never filtered: the averages card and waterfall draw a
 * fixed five rows so the card does not resize when a run starts reporting, with "-" for a value not
 * there yet.
 */
export function phasesFromAverages(
	source: TimingAverageSource | null | undefined
): MaybeResolvedTimingPhase[] {
	return TIMING_PHASES.map((phase) => ({ ...phase, value: source?.[phase.averageKey] }));
}

/**
 * Whether a `timingBreakdown` carries the averages half. It holds two independently present halves,
 * averages (the phase histograms' means, or the retained trace sample's without them) and `phases`
 * percentiles over every completion, so the object says nothing about the averages; renderers ask
 * this, so a phases-only report paints no five zeroed bars and "0 ms" total.
 */
export function hasPhaseAverages(source: TimingAverageSource | null | undefined): boolean {
	return TIMING_PHASES.some((phase) => source?.[phase.averageKey] !== undefined);
}

/** One phase's whole-run distribution, as the engine writes it. */
export interface TimingPhasePercentiles {
	p50: number;
	p95: number;
	p99: number;
	max: number;
	/** Completions behind this distribution; identical across the five. */
	count: number;
}

/** Any object carrying per-run percentiles: a report's `timingBreakdown.phases`. */
export type TimingPercentileSource = Partial<
	Record<TimingPhasePercentileKey, TimingPhasePercentiles | undefined>
>;

/** A phase paired with its whole-run distribution. */
export interface ResolvedPhasePercentiles extends TimingPhase {
	percentiles: TimingPhasePercentiles;
}

/**
 * The phases a run reported percentiles for, in wire order, filtering like `phasesFromTrace` and
 * unlike `phasesFromAverages`: the table renders only when the section exists, and an unwritten
 * phase is unmeasured. An empty list for an absent section, the caller's signal to render nothing.
 */
export function phasesFromPercentiles(
	source: TimingPercentileSource | null | undefined
): ResolvedPhasePercentiles[] {
	return TIMING_PHASES.map((phase) => ({
		...phase,
		percentiles: source?.[phase.percentileKey],
	})).filter((phase): phase is ResolvedPhasePercentiles => phase.percentiles !== undefined);
}

/**
 * A phase's p99 over its p50, or `null` when the tail cannot be read. A p99 towering over its p50
 * is what the percentile table surfaces: classically TLS, where a p50 of 0 (reused connections)
 * beside a large p99 means re-handshaking under load, which an average flattens to merely mediocre.
 * `null` for a zero p50, where the ratio is unbounded; callers read `p99` directly, a zero p50 with
 * a real p99 being itself the finding.
 */
export function tailRatio(percentiles: TimingPhasePercentiles): number | null {
	return percentiles.p50 > 0 ? percentiles.p99 / percentiles.p50 : null;
}
