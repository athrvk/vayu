/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { RunReport } from "@/types";
import { InfoChip } from "../shared";
import { formatPhaseDuration } from "@/components/shared/response-viewer/utils";
import {
	phaseColor,
	phasesFromPercentiles,
	tailRatio,
	type ResolvedPhasePercentiles,
} from "@/components/shared/response-viewer/timing-phases";

/**
 * Per-phase percentiles - from `report.timingBreakdown.phases`.
 *
 * The companion to `TimingWaterfall`, and deliberately a separate component
 * rather than more rows inside it: the waterfall shows *averages over the
 * retained trace sample* and this shows *percentiles over every completion*.
 * They are different populations, so stacking them in one table would invite
 * the reader to compare a column against its neighbour.
 *
 * Renders nothing at all when the section is absent - a run whose engine had
 * `phaseHistograms` off, or one recorded before the bank existed, has no
 * distribution to show and an empty table would claim otherwise.
 *
 * The tail callout is the reason a percentile view beats an average one: a TLS
 * p50 of 0 beside a p99 of 40ms is a run re-handshaking under load, and the
 * mean of the two is a number that looks merely unremarkable.
 */
export function PhasePercentiles({ report }: { report: RunReport | null }) {
	const phases = phasesFromPercentiles(report?.timingBreakdown?.phases);
	if (phases.length === 0) {
		return null;
	}

	const flagged = phases.filter(isTailHeavy);
	// Identical across the five (they are fed together), so the first answers
	// for the run. Printed once rather than per row.
	const sampleCount = phases[0].percentiles.count;

	return (
		<div className="space-y-2.5">
			<div className="grid grid-cols-[68px_repeat(4,1fr)] gap-2.5 text-[11px] text-muted-foreground">
				<span />
				<span className="text-right font-medium">p50</span>
				<span className="text-right font-medium">p95</span>
				<span className="text-right font-medium">p99</span>
				<span className="text-right font-medium">max</span>
			</div>

			{phases.map((phase) => (
				<div
					key={phase.key}
					className="grid grid-cols-[68px_repeat(4,1fr)] items-center gap-2.5"
				>
					<span className="text-[11px] text-muted-foreground flex items-center">
						<span
							aria-hidden
							className="inline-block size-2 rounded-full mr-1.5 shrink-0"
							style={{ background: phaseColor(phase) }}
						/>
						{phase.label}
						<InfoChip tip={phase.tip} />
					</span>
					<PhaseValue value={phase.percentiles.p50} />
					<PhaseValue value={phase.percentiles.p95} />
					<PhaseValue value={phase.percentiles.p99} emphasis />
					<PhaseValue value={phase.percentiles.max} />
				</div>
			))}

			<p className="pt-2.5 border-t border-dashed border-border text-[11px] text-muted-foreground">
				Every completion ({sampleCount.toLocaleString()}), not the trace sample.
			</p>

			{flagged.length > 0 && (
				<p className="text-[11px] text-warning-text">
					{flagged.map((phase) => phase.label).join(" and ")}{" "}
					{flagged.length === 1 ? "has" : "have"} a p99 far above the p50 - a minority of
					requests paid this phase while most skipped it. For TLS or Connect that is
					connection churn under load rather than a slow server.
				</p>
			)}
		</div>
	);
}

/**
 * A phase whose tail is worth naming: p99 at least an order of magnitude over
 * p50, or a p50 of zero with a p99 that is not.
 *
 * The zero-p50 branch is not an edge case to tolerate - it is the *strongest*
 * form of the finding. A reused connection does no handshake, so a run with
 * healthy pooling has a TLS p50 of exactly 0; a non-zero p99 beside it means
 * some requests did handshake, and `tailRatio` cannot express that as a number.
 *
 * The sub-millisecond floor keeps the callout off phases that are simply fast:
 * a p50 of 0.01ms and a p99 of 0.4ms is a 40x ratio and 0.4ms of nothing.
 */
const TAIL_RATIO_THRESHOLD = 10;
const TAIL_FLOOR_MS = 1;

function isTailHeavy(phase: ResolvedPhasePercentiles): boolean {
	const { p50, p99 } = phase.percentiles;
	if (p99 < TAIL_FLOOR_MS) {
		return false;
	}
	const ratio = tailRatio(phase.percentiles);
	return ratio === null ? p50 === 0 : ratio >= TAIL_RATIO_THRESHOLD;
}

function PhaseValue({ value, emphasis }: { value: number; emphasis?: boolean }) {
	const duration = formatPhaseDuration(value);
	return (
		<span className="text-right font-mono tabular-nums text-[11px]">
			<span className={emphasis ? "text-foreground font-medium" : "text-foreground"}>
				{duration.value}
			</span>
			<span className="text-subtle-foreground ml-0.5">{duration.unit}</span>
		</span>
	);
}
