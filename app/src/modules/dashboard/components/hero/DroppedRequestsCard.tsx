/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatNumber, formatPercent, formatSeconds } from "@/lib/format-number";
import { pluralize } from "../../utils/format";
import { HeroCardShell, HeroValue } from "./HeroCardShell";

/**
 * Replaces the Rate Fidelity hero card when a constant_rps run lost requests,
 * in one of two ways that name different culprits:
 *
 * - dropped: the generator could not submit because its in-flight pool filled
 *   up, so the server is the bottleneck;
 * - skipped (#2911): the generator stalled and the pacer let go of the backlog
 *   older than its catch-up window instead of bursting. That is the generator
 *   or its host, so a run with skips alone draws no "Server saturating" advice.
 *
 * `skipped` and `stalledMs` are optional so a caller with neither (an older
 * report) draws exactly the dropped-only card.
 */
export function DroppedRequestsCard({
	dropped,
	completed,
	skipped = 0,
	stalledMs = 0,
}: {
	dropped: number;
	completed: number;
	skipped?: number;
	stalledMs?: number;
}) {
	const scheduled = dropped + skipped + completed;
	const pct = scheduled > 0 ? (dropped / scheduled) * 100 : 0;
	const skippedOnly = dropped === 0 && skipped > 0;
	const skippedPct = scheduled > 0 ? (skipped / scheduled) * 100 : 0;

	return (
		<HeroCardShell
			label={skippedOnly ? "Skipped requests" : "Dropped requests"}
			tip={skippedOnly ? <SkippedTip /> : <DroppedTip withSkipped={skipped > 0} />}
		>
			<HeroValue
				value={formatNumber(skippedOnly ? skipped : dropped)}
				color={skippedOnly ? "hsl(var(--warning-text))" : "hsl(var(--destructive-text))"}
			/>
			<p className="text-label text-muted-foreground font-mono mt-0.5">
				of <span className="text-foreground font-semibold">{formatNumber(scheduled)}</span>{" "}
				scheduled ·{" "}
				<span className="text-foreground font-semibold">
					{formatPercent(skippedOnly ? skippedPct : pct)}
				</span>
				%
			</p>
			{skipped > 0 ? (
				<p className="text-label mt-2 text-warning-text">
					{formatNumber(skipped)} {pluralize(skipped, "request")} skipped: the load
					generator stalled for {formatSeconds(stalledMs / 1000)}
				</p>
			) : null}
			{skippedOnly ? null : (
				<p className="text-label mt-2 text-warning-text">
					Server saturating - try lowering target RPS
				</p>
			)}
		</HeroCardShell>
	);
}

function DroppedTip({ withSkipped }: { withSkipped: boolean }) {
	return (
		<>
			Requests the generator couldn't submit because its in-flight pool filled up. Root cause
			is usually slow server responses tying up curl handles. Lowering <code>targetRps</code>{" "}
			or raising <code>maxInFlight</code> defers drops in exchange for higher queue wait - but
			the server is still the bottleneck.
			{withSkipped ? (
				<>
					{" "}
					Skipped requests are counted apart: they come from the generator stalling, not
					the server.
				</>
			) : null}
		</>
	);
}

function SkippedTip() {
	return (
		<>
			Requests the generator owed after it stalled and let go of rather than send in a burst.
			Only the backlog older than 100 ms is skipped, and the stall time is the schedule those
			requests covered. This points at the load generator or its host, not the server.
		</>
	);
}
