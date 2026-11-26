/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One sampled HTTP exchange: a summary row expanding into the detail. One shell, as the dashboard's
 * and History's two copies (#76) drifted in almost every detail but data despite sharing
 * per-concern primitives (#60); the dashboard now renders History's report (#2220).
 * **Presentational, over already-shaped data**: a status code, a latency and a pre-resolved phase
 * list, whether from SSE or SQLite. Expansion is the parent's state (the history detail holds one
 * open index), the split `LoadTestDetail` uses to reuse the dashboard's derived components. **What
 * a caller adds stays a slot, not a flag**: the history card's sections (trace details: error type,
 * data row, per-test failures, the slow-request warning; then request and response) arrive as
 * `details` (before the timing tiles) and `children` (after), not booleans, which the response
 * viewers were deliberately not merged into. The `timestamp` is a caller-formatted `ReactNode`: a
 * stored row dates a run and wants the day; a sample within a seconds-old run would want
 * milliseconds.
 */

import { type ReactNode } from "react";
import {
	AlertCircle,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Clock,
	MinusCircle,
} from "lucide-react";

import { RUN_STATUS } from "@/components/shared/run-status";
import { Button, Collapsible, CollapsibleContent } from "@/components/ui";
import { isErrorStatus } from "@/constants/http-status";
import { formatLatency } from "@/lib/format-number";
import { cn } from "@/lib/utils";

import { StatusCodeBadge } from "./StatusCodeBadge";
import TimingPhaseTiles from "./TimingPhaseTiles";
import { TruncatedText } from "../TruncatedText";
import type { ResolvedTimingPhase } from "./timing-phases";
import { isReportedMs } from "./utils";

/**
 * How the row reads at a glance: its icon and colour, normally derived from the exchange, all a
 * load-run sample has. A collection run's step knows better: `failed` is a test assertion that did
 * not hold over a good `200`, `skipped` a step that never ran, and derivation would read the first
 * as success and the second as a connection failure, so such a caller states the outcome. A
 * `stopped` step was cut by the run's Stop (#3397); its cancelled transfer is no failure either.
 */
export type ExchangeState = "success" | "error" | "slow" | "skipped" | "stopped";

const STATE_ICON: Record<ExchangeState, typeof CheckCircle2> = {
	success: CheckCircle2,
	error: AlertCircle,
	slow: Clock,
	skipped: MinusCircle,
	stopped: RUN_STATUS.stopped.icon,
};

const STATE_TINT: Record<ExchangeState, string> = {
	success: "text-status-success-text",
	error: "text-destructive-text",
	slow: "text-status-stopped-text",
	skipped: "text-muted-foreground",
	stopped: RUN_STATUS.stopped.text,
};

/**
 * The summary row's tracks: chevron, state icon, label, the flexible lead (name and error), then
 * from `@3xl` status, latency and time. The status track fits "503 Service Unavailable" so a list's
 * chips share a column; each row is its own grid, so only fixed tracks line up. `@3xl` is a
 * *container* variant against the row's `@container`: a viewport variant does not know the context
 * bar is open.
 */
const ROW_GRID =
	"grid grid-cols-[auto_auto_3.5rem_minmax(0,1fr)] @3xl:grid-cols-[auto_auto_3.5rem_minmax(0,1fr)_12rem_4.5rem_auto]";

export interface SampledExchangeProps {
	/** Printed as `#{label}`. The dashboard prefers the engine's request number. */
	label: ReactNode;
	/**
	 * Named beside the label (a collection run's step name); load-run samples (one request,
	 * repeated) leave it absent.
	 */
	title?: ReactNode;
	/**
	 * Overrides the state derived from `error` / `isSlow` / `statusCode`; only for a caller knowing
	 * something the exchange does not.
	 */
	state?: ExchangeState;
	/**
	 * Absent for an exchange that never reached the wire (a skipped step), drawing no badge, where
	 * `0` would draw "ERR" for an unsent request.
	 */
	statusCode?: number;
	statusText?: string;
	/** Absent with {@link statusCode}: no request, no time. */
	latencyMs?: number;
	/** Formatted by the caller - see the note on live vs stored in the header. */
	timestamp: ReactNode;
	error?: string;
	/** Exceeded the run's configured slow-request threshold. */
	isSlow?: boolean;
	/** From `phasesFromTrace()`. Empty hides the breakdown unless `scriptMs` is reported. */
	phases?: readonly ResolvedTimingPhase[];
	/**
	 * The exchange's script time (`trace.scriptMs`, #3739), a "Scripts" tile in the breakdown;
	 * unlike an empty `phases`, a `0` still opens the section, and absent, NaN or negative draws
	 * nothing.
	 */
	scriptMs?: number;
	isExpanded: boolean;
	onToggle: () => void;
	/**
	 * Controls beside the summary, outside the toggle (a step's link to its request, #730).
	 * Outside, as the summary is one `<button>`: a nested control is invalid and would fire the
	 * toggle. With none, the row is one button wide.
	 */
	actions?: ReactNode;
	/** Expanded sections between the error block and the timing tiles. */
	details?: ReactNode;
	/** Expanded sections after the timing tiles - headers and body. */
	children?: ReactNode;
	className?: string;
}

export function SampledExchange({
	label,
	title,
	state,
	statusCode,
	statusText,
	latencyMs,
	timestamp,
	error,
	isSlow = false,
	phases = [],
	scriptMs,
	isExpanded,
	onToggle,
	actions,
	details,
	children,
	className,
}: SampledExchangeProps) {
	// A status outside 200-399 is an error by the engine's definition (#2124), so a 500 or 429
	// wears no tick; a connection failure (status 0) has no code, so the icon alone says it did not
	// come back.
	const badStatus = statusCode !== undefined && isErrorStatus(statusCode);
	const derived: ExchangeState = error || badStatus ? "error" : isSlow ? "slow" : "success";
	const resolved = state ?? derived;
	const isError = resolved === "error";
	const StatusIcon = STATE_ICON[resolved];
	const Chevron = isExpanded ? ChevronDown : ChevronRight;

	// The first clause only: the full message is a click away, and a multi-line curl error would
	// make the row three lines.
	const errorPreview = isError && error ? error.split(":")[0] : "";
	const hasLead = Boolean(title) || errorPreview !== "";

	return (
		<div className={cn("@container overflow-hidden", className)}>
			<Collapsible open={isExpanded} onOpenChange={onToggle}>
				{/*
				 * The summary and its actions share a row, not a button; without actions it is one
				 * full-width button.
				 */}
				<div className="flex items-stretch">
					<Button
						type="button"
						variant="listRow"
						onClick={onToggle}
						aria-expanded={isExpanded}
						// `rounded-none` over `rounded-md`: every caller renders this full-bleed (a
						// `divide-y` list, a `border-b` strip), where a rounded hover would float.
						className={cn(
							ROW_GRID,
							"flex-1 min-w-0 items-center gap-x-3 gap-y-1 rounded-none px-4 py-3 hover:bg-muted/50"
						)}
					>
						<Chevron className="size-icon text-muted-foreground shrink-0" />

						<StatusIcon className={cn("size-icon shrink-0", STATE_TINT[resolved])} />

						<span className="truncate text-xs text-muted-foreground font-mono">
							#{label}
						</span>

						{hasLead && (
							// The step's name and the error's first clause share the flexible
							// track; the caller's `title` has its own shape, so this box shrinks
							// (`min-w-0`) around it.
							<span className="col-start-4 row-start-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 @3xl:flex-nowrap">
								{title && <span className="min-w-0 max-w-full">{title}</span>}
								{errorPreview !== "" && (
									<TruncatedText className="min-w-0 max-w-full basis-full text-xs text-destructive-text @3xl:max-w-[40%] @3xl:basis-auto">
										{errorPreview}
									</TruncatedText>
								)}
							</span>
						)}

						{/*
						 * Below @3xl status, latency and time are one wrapping group under the
						 * name; from @3xl the group dissolves (`contents`) into the row's tracks,
						 * so a list's rows line up. A missing cell leaves its track empty.
						 */}
						<span
							className={cn(
								"flex flex-wrap items-center gap-x-3 gap-y-1 @3xl:contents",
								hasLead
									? "col-span-2 col-start-3 row-start-2"
									: "col-start-4 row-start-1"
							)}
						>
							{statusCode !== undefined && (
								<StatusCodeBadge
									status={statusCode}
									statusText={statusText}
									className="shrink-0 @3xl:col-start-5 @3xl:max-w-full @3xl:justify-self-start @3xl:overflow-hidden"
								/>
							)}

							{latencyMs !== undefined && (
								<span
									className={cn(
										"text-sm font-mono shrink-0 @3xl:col-start-6 @3xl:text-right",
										isSlow && "text-status-stopped-text"
									)}
								>
									{formatLatency(latencyMs)}
								</span>
							)}

							<span className="text-xs text-muted-foreground @3xl:col-start-7 @3xl:text-right">
								{timestamp}
							</span>
						</span>
					</Button>

					{actions && <div className="flex shrink-0 items-center pr-3">{actions}</div>}
				</div>

				<CollapsibleContent>
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

						{(phases.length > 0 || isReportedMs(scriptMs)) && (
							<div className="space-y-1">
								<p className="text-xs font-medium text-muted-foreground">
									Timing breakdown
								</p>
								<TimingPhaseTiles phases={phases} scriptMs={scriptMs} />
							</div>
						)}

						{children}
					</div>
				</CollapsibleContent>
			</Collapsible>
		</div>
	);
}
