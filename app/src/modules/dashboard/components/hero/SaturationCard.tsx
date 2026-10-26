/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ReactNode } from "react";
import { concurrencyUnit } from "@/constants/load-test-modes";
import { STOP_REASONS, type CapacityResult } from "@/components/shared/capacityStop";
import { TOOLTIPS } from "../tooltips";
import { sloLineName, type Breakpoint, type SloSource } from "../../utils/computeBreakpoint";
import { formatLatency, formatNumber, formatPercent, formatRate } from "@/lib/format-number";
import { pluralize } from "../../utils/format";
import { HeroCardShell } from "./HeroCardShell";

/**
 * The `-text` variants, not the bare fill tokens.
 *
 * This was an inline `style={{ color: "hsl(var(--warning))" }}`. Measured on
 * `--card`, `--warning` is 2.14 and `--destructive` 1.73 - this is the same
 * "fill token used as a foreground" bug swept out of the app earlier, and it
 * survived because the guard scans for the `text-<family>` *class* and an
 * inline style is invisible to it. The guard now covers both forms.
 */
const WARNING_CLASS = "text-warning-text";

/** Bespoke body (22px text headline, not the 34px HeroValue numeric). */
function SaturationShell({
	headline,
	colorClass,
	children,
}: {
	headline: string;
	colorClass: string;
	children?: ReactNode;
}) {
	return (
		<HeroCardShell label="Saturation" tip={TOOLTIPS.saturation}>
			<div className="flex items-baseline gap-1 mt-1">
				<span
					className={`text-metric font-bold leading-none transition-colors duration-150 ${colorClass}`}
				>
					{headline}
				</span>
			</div>
			{children}
		</HeroCardShell>
	);
}

function Line({ children }: { children: ReactNode }) {
	return <p className="text-label text-muted-foreground font-mono mt-0.5">{children}</p>;
}

function Figure({ children }: { children: ReactNode }) {
	return <span className="text-foreground font-semibold">{children}</span>;
}

/** " at 45 virtual users"; nothing where the level is unknown. */
function AtLevel({ concurrency }: { concurrency: number | null | undefined }) {
	if (concurrency == null) return null;
	return (
		<>
			{" at "}
			<Figure>{formatNumber(concurrency)}</Figure> {concurrencyUnit(concurrency)}
		</>
	);
}

/**
 * Where p99 went over the SLO. The ramp reads it off its ticks and the capacity
 * card off the search's knee; either may lack the figure, and the line then
 * names what it has.
 */
function P99Crossed({
	p99Ms,
	sloMs,
	sloSource,
	concurrency,
}: {
	p99Ms: number | null | undefined;
	sloMs: number | null | undefined;
	sloSource: SloSource;
	concurrency: number | null | undefined;
}) {
	const line = sloMs == null ? null : `the ${formatLatency(sloMs)} ${sloLineName(sloSource)}`;
	return (
		<Line>
			p99 crossed {p99Ms != null && <Figure>{formatLatency(p99Ms)}</Figure>}
			{line !== null && (p99Ms == null ? line : ` (${line})`)}
			<AtLevel concurrency={concurrency} />
		</Line>
	);
}

/**
 * ramp_up hero card #2 - whether the server has hit its capacity ceiling.
 * "Degrading" when p99 has crossed the SLO breakpoint or transport errors have
 * appeared; the call-out names the concurrency at which degradation began.
 * A capacity run reads {@link CapacitySaturationCard} instead, which never says
 * "healthy": a search that found no limit has not shown the target healthy.
 */
export function SaturationCard({
	breakpoint,
	failedRequests,
}: {
	breakpoint: Breakpoint;
	failedRequests: number;
}) {
	const degrading = breakpoint.crossed || failedRequests > 0;

	return (
		<SaturationShell
			headline={degrading ? "⚠ degrading" : "✓ healthy"}
			colorClass={degrading ? WARNING_CLASS : "text-success-text"}
		>
			{breakpoint.crossed && (
				<P99Crossed
					p99Ms={breakpoint.p99Ms}
					sloMs={breakpoint.sloMs}
					sloSource={breakpoint.sloSource}
					concurrency={breakpoint.concurrency}
				/>
			)}
		</SaturationShell>
	);
}

interface CapacityReading {
	headline: string;
	/** Whether the search found something wrong with the target, which is what the warning colour means. */
	found: boolean;
}

const SEARCHING: CapacityReading = { headline: "searching", found: false };
const NO_LIMIT: CapacityReading = { headline: "no limit found", found: false };
const NO_RESULT: CapacityReading = { headline: "no result", found: false };

/**
 * The headline follows why the search stopped (`STOP_REASONS`), the table the
 * Capacity summary words its badge from. A report without the section, or with
 * a reason this build has no words for, claims neither a limit nor its absence.
 */
function readCapacity(capacity: CapacityResult | undefined, isCompleted: boolean): CapacityReading {
	if (!capacity) return isCompleted ? NO_RESULT : SEARCHING;
	switch (STOP_REASONS[capacity.stopReason]?.finding) {
		case "degrading":
			return { headline: "⚠ degrading", found: true };
		case "saturated":
			return { headline: "⚠ saturated", found: true };
		case "none":
			return NO_LIMIT;
		default:
			return NO_RESULT;
	}
}

function ErrorsExceeded({ capacity }: { capacity: CapacityResult }) {
	const { kneeErrorPct, kneeConcurrency } = capacity;
	return (
		<Line>
			{kneeErrorPct === undefined ? (
				STOP_REASONS.errors_exceeded.label
			) : (
				<>
					<Figure>{formatPercent(kneeErrorPct)}%</Figure> of requests failed
				</>
			)}
			<AtLevel concurrency={kneeConcurrency} />
		</Line>
	);
}

/** Where throughput stopped growing; a plateau stored before `saturation*` existed names no level. */
function PlateauReached({ capacity }: { capacity: CapacityResult }) {
	const { saturationConcurrency, saturationRps } = capacity;
	return (
		<Line>
			Throughput stopped growing
			<AtLevel concurrency={saturationConcurrency} />
			{saturationRps !== undefined && (
				<>
					{" ("}
					<Figure>{formatRate(saturationRps)}</Figure> req/s)
				</>
			)}
		</Line>
	);
}

/** The line under the headline: what the stop was, in the numbers the search recorded. */
function StopReasonLine({ capacity }: { capacity: CapacityResult }) {
	switch (capacity.stopReason) {
		case "slo_exceeded":
			return (
				<P99Crossed
					p99Ms={capacity.kneeP99Ms}
					sloMs={capacity.sloMs}
					sloSource="run"
					concurrency={capacity.kneeConcurrency}
				/>
			);
		case "errors_exceeded":
			return <ErrorsExceeded capacity={capacity} />;
		case "plateau":
			return <PlateauReached capacity={capacity} />;
		default:
			return <Line>{STOP_REASONS[capacity.stopReason]?.label ?? capacity.stopReason}</Line>;
	}
}

/**
 * What the ticks show while the search has not stopped: the p99 crossing the
 * run's SLO. Evidence, not a verdict, since the search needs two consecutive
 * windows over before it calls the budget exceeded.
 */
function LiveCrossing({ breakpoint }: { breakpoint: Breakpoint }) {
	if (!breakpoint.crossed) return null;
	return (
		<P99Crossed
			p99Ms={breakpoint.p99Ms}
			sloMs={breakpoint.sloMs}
			sloSource={breakpoint.sloSource}
			concurrency={breakpoint.concurrency}
		/>
	);
}

/**
 * Errors the search did not stop on. They never light the card, since the
 * search judges errors against its own limit, but they are not hidden either.
 */
function ErrorCount({ failedRequests, live }: { failedRequests: number; live: boolean }) {
	return (
		<Line>
			<Figure>{formatNumber(failedRequests)}</Figure> {pluralize(failedRequests, "error")}
			{live && " so far"}
		</Line>
	);
}

/**
 * capacity hero card #2 - what the adaptive search concluded about the target.
 * The search ends on a reason the engine records in the report, so a live run
 * reads "searching" (with the ticks' p99 crossing as evidence) and a finished
 * one words that reason. "No limit found" is the neutral reading of a search
 * that ran out of ceiling, time or patience, and "healthy" is never printed.
 */
export function CapacitySaturationCard({
	capacity,
	isCompleted,
	breakpoint,
	failedRequests,
}: {
	capacity: CapacityResult | undefined;
	isCompleted: boolean;
	breakpoint: Breakpoint;
	failedRequests: number;
}) {
	const reading = readCapacity(capacity, isCompleted);
	const errorsStoppedIt = capacity?.stopReason === "errors_exceeded";

	return (
		<SaturationShell
			headline={reading.headline}
			colorClass={reading.found ? WARNING_CLASS : "text-foreground"}
		>
			{capacity ? (
				<StopReasonLine capacity={capacity} />
			) : (
				<LiveCrossing breakpoint={breakpoint} />
			)}
			{failedRequests > 0 && !errorsStoppedIt && (
				<ErrorCount failedRequests={failedRequests} live={!isCompleted} />
			)}
		</SaturationShell>
	);
}
