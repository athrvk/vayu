/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One sampled HTTP exchange: a summary row you can expand into the detail.
 *
 * Two views show this - the dashboard's live sample list and the history
 * detail's stored one - and they were two separate components (#76). #60 had
 * already given them the same per-concern primitives (`StatusCodeBadge`,
 * `HeadersViewer`, `ResponseBody`), so the drift moved up a level and lived in
 * the shells: each owned its own summary row, its own expansion chrome, its own
 * section order. A spacing or empty-state fix to one still did not reach the
 * other, and by the time this was written the rows had diverged in almost every
 * detail that is not data - one opened with a chevron and the other with a
 * hand-drawn CSS triangle, one used AlertCircle/Clock/CheckCircle2 and the
 * other XCircle/CheckCircle, one printed `HH:MM:SS.mmm` and the other a full
 * locale date, and only one had a slow-request state at all.
 *
 * **Presentational, over already-shaped data.** It takes a status code, a
 * latency and a pre-resolved phase list; it does not know whether they arrived
 * over SSE a moment ago or came out of SQLite. Expansion is the parent's state,
 * as it already was on the history side - the dashboard holds a `Set` of open
 * indices and the history detail one open index, and neither belongs in here.
 * That is the same split `LoadTestDetail` uses to reuse the dashboard's derived
 * components.
 *
 * **What differs by site stays a slot, not a flag.** The expanded sections are
 * genuinely different - the dashboard has an error type, per-test failures and
 * a slow-request warning; the history card shows request headers - so they
 * arrive as `details` (before the timing tiles) and `children` (after). The
 * alternative was a component driven by booleans, which is what the response
 * viewers were deliberately not merged into.
 *
 * The `timestamp` is a `ReactNode` the caller formats, for the one difference
 * that is real rather than incidental: a live row is placing a sample within a
 * run that is seconds old and wants milliseconds, while a stored row is dating
 * a run and wants the day.
 */

import { type ReactNode } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Clock } from "lucide-react";

import { cn } from "@/lib/utils";

import { StatusCodeBadge } from "./StatusCodeBadge";
import TimingPhaseTiles from "./TimingPhaseTiles";
import type { ResolvedTimingPhase } from "./timing-phases";

export interface SampledExchangeProps {
	/** Printed as `#{label}`. The dashboard prefers the engine's request number. */
	label: ReactNode;
	statusCode: number;
	statusText?: string;
	latencyMs: number;
	/** Formatted by the caller - see the note on live vs stored in the header. */
	timestamp: ReactNode;
	error?: string;
	/** Exceeded the run's configured slow-request threshold. */
	isSlow?: boolean;
	/** From `phasesFromTrace()`. Empty hides the breakdown entirely. */
	phases?: readonly ResolvedTimingPhase[];
	isExpanded: boolean;
	onToggle: () => void;
	/** Expanded sections between the error block and the timing tiles. */
	details?: ReactNode;
	/** Expanded sections after the timing tiles - headers and body. */
	children?: ReactNode;
	className?: string;
}

export function SampledExchange({
	label,
	statusCode,
	statusText,
	latencyMs,
	timestamp,
	error,
	isSlow = false,
	phases = [],
	isExpanded,
	onToggle,
	details,
	children,
	className,
}: SampledExchangeProps) {
	// A connection failure has no status code to show, so the row's icon is the
	// only thing that says "this one did not come back".
	const isError = !!error || statusCode === 0;
	const StatusIcon = isError ? AlertCircle : isSlow ? Clock : CheckCircle2;
	const Chevron = isExpanded ? ChevronDown : ChevronRight;

	return (
		<div className={cn("overflow-hidden", className)}>
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={isExpanded}
				className="w-full flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-left hover:bg-muted/50 transition-colors"
			>
				<Chevron className="w-4 h-4 text-muted-foreground shrink-0" />

				<StatusIcon
					className={cn(
						"w-4 h-4 shrink-0",
						isError
							? "text-destructive-text"
							: isSlow
								? "text-status-stopped-text"
								: "text-status-success-text"
					)}
				/>

				<span className="text-xs text-muted-foreground font-mono min-w-8">#{label}</span>

				<StatusCodeBadge status={statusCode} statusText={statusText} className="shrink-0" />

				<span
					className={cn(
						"text-sm font-mono shrink-0",
						isSlow && "text-status-stopped-text"
					)}
				>
					{latencyMs.toFixed(1)}ms
				</span>

				<span className="text-xs text-muted-foreground sm:ml-auto">{timestamp}</span>

				{/* First clause only - the full message is one click away, and a
				    multi-line curl error would push the row to three lines. */}
				{isError && error && (
					<span className="text-xs text-destructive-text truncate basis-full sm:basis-auto sm:max-w-[200px]">
						{error.split(":")[0]}
					</span>
				)}
			</button>

			{isExpanded && (
				<div className="px-4 py-3 bg-muted/30 border-t border-rule space-y-3">
					{error && (
						<div className="space-y-1">
							<p className="text-xs font-medium text-muted-foreground">Error</p>
							<p className="bg-destructive/10 text-destructive-text p-2 rounded-md font-mono text-xs break-all">
								{error}
							</p>
						</div>
					)}

					{details}

					{phases.length > 0 && (
						<div className="space-y-1">
							<p className="text-xs font-medium text-muted-foreground">
								Timing Breakdown
							</p>
							<TimingPhaseTiles phases={phases} />
						</div>
					)}

					{children}
				</div>
			)}
		</div>
	);
}
