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
	type TimingPhaseKey,
} from "@/components/shared/response-viewer/timing-phases";
import { pluralize } from "@/modules/dashboard/utils/format";

/**
 * Per-phase percentiles - from `report.timingBreakdown.phases`, which History
 * reads off the stored report and the live view fills from the latest gate
 * frame (`utils/liveDistributions.ts`).
 *
 * The companion to `TimingWaterfall`, and deliberately a separate component
 * rather than more rows inside it: the waterfall shows one *mean* per phase and
 * this shows *percentiles*, and a mean stacked in a column beside a p99 invites
 * the reader to compare them. Both cover every completion for a run whose
 * engine kept the phase histograms; only a report stored before the bank held
 * means has a waterfall over the retained trace sample, and this table is the
 * same every-completion figure either way.
 *
 * Renders nothing at all when the section is absent - a run whose engine had
 * `phaseHistograms` off, or one recorded before the bank existed, has no
 * distribution to show and an empty table would claim otherwise.
 *
 * The tail callout is the reason a percentile view beats an average one: a TLS
 * p50 of 0 beside a p99 of 40ms is a run re-handshaking under load, and the
 * mean of the two is a number that looks merely unremarkable. What a tail means
 * depends on the phase, so each flagged phase is explained by its own group
 * (`TAIL_GROUPS`).
 */
export function PhasePercentiles({
	report,
}: {
	report: Pick<RunReport, "timingBreakdown"> | null;
}) {
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
			<div className="grid grid-cols-[68px_repeat(4,1fr)] gap-2.5 text-label text-muted-foreground">
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
					<span className="text-label text-muted-foreground flex items-center">
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

			<p className="pt-2.5 border-t border-dashed border-rule text-label text-muted-foreground">
				Over every completion ({sampleCount.toLocaleString()}).
			</p>

			{tailNotes(flagged).map((note) => (
				<p key={note.key} className="text-label text-warning-text">
					{note.text}
				</p>
			))}
		</div>
	);
}

interface TailGroup {
	phases: readonly TimingPhaseKey[];
	/** The sentence for the flagged members of this group, labels in hand. */
	note: (flagged: readonly ResolvedPhasePercentiles[]) => string;
}

/**
 * Which sentence a flagged phase gets, in the order they print. A phase belongs
 * to one group, so the sentence is only ever true of the phases it names:
 * "a minority paid while most skipped it" holds for the phases a reused
 * connection skips, and is false for TTFB, which every request pays.
 */
const TAIL_GROUPS: readonly TailGroup[] = [
	{
		phases: ["dns", "connect", "tls"],
		note: (flagged) =>
			`${flagged.map((phase) => phase.label).join(" and ")} ` +
			`${pluralize(flagged.length, "has", "have")} a p99 far above the p50 - a minority ` +
			"of requests paid this phase while most skipped it. For TLS or Connect that is " +
			"connection churn under load rather than a slow server.",
	},
	{
		phases: ["ttfb"],
		note: () =>
			"TTFB has a p99 far above the p50: a minority of responses took much longer than " +
			"the rest, which is the target's own slow tail.",
	},
	{
		phases: ["download"],
		note: () =>
			"Download has a p99 far above the p50: a few responses took much longer to " +
			"transfer than the rest.",
	},
];

function tailNotes(flagged: readonly ResolvedPhasePercentiles[]): { key: string; text: string }[] {
	return TAIL_GROUPS.flatMap((group) => {
		const members = flagged.filter((phase) => group.phases.includes(phase.key));
		return members.length > 0 ? [{ key: group.phases[0], text: group.note(members) }] : [];
	});
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
		<span className="text-right font-mono tabular-nums text-label">
			<span className={emphasis ? "text-foreground font-medium" : "text-foreground"}>
				{duration.value}
			</span>
			<span className="text-subtle-foreground ml-0.5">{duration.unit}</span>
		</span>
	);
}
