/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type React from "react";
import { formatRelativeTime, loadTestTypeToLabel } from "@/utils";
import type { Run } from "@/types";
import { RUN_KIND_LABEL } from "@/modules/history/types";
import { Badge, Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { MethodBadge } from "@/components/shared";
import { HTTP_VERSIONS, isHttpVersion } from "@/constants/request";
import { formatConcurrency } from "@/constants/load-test-modes";
import {
	CheckCircle2,
	XCircle,
	Activity,
	StopCircle,
	Clock,
	Loader2,
	Trash2,
	Zap,
	Network,
	ListOrdered,
	Repeat,
	Folder,
	FolderTree,
	Pin,
	PinOff,
} from "lucide-react";

interface RunItemProps {
	run: Run;
	onSelect: (runId: string) => void;
	onDelete: (runId: string, event: React.MouseEvent) => void;
	/**
	 * Pin or unpin this run as its request's baseline. Absent for run types
	 * that have nothing to compare against - see the action's own comment.
	 */
	onToggleBaseline?: (runId: string, baseline: boolean, event: React.MouseEvent) => void;
	isDeleting: boolean;
	isTogglingBaseline?: boolean;
	isSelected?: boolean;
	/**
	 * The name of the collection a scenario run ran, resolved by the list from
	 * the loaded tree.
	 *
	 * A prop rather than a query in here: the row is presentational over
	 * already-shaped data (the summary), one collections query serves the whole
	 * page, and a hook here would make every row a query subscriber. Absent for
	 * every other run type, and for a collection deleted since the run.
	 */
	collectionName?: string;
}

export default function RunItem({
	run,
	onSelect,
	onDelete,
	onToggleBaseline,
	isDeleting,
	isTogglingBaseline = false,
	isSelected = false,
	collectionName,
}: RunItemProps) {
	// Format timestamp to relative time
	const formatTime = (timestamp: number) => {
		if (!timestamp) return "Unknown";
		return formatRelativeTime(new Date(timestamp).toISOString());
	};

	// Read from the compact list-row summary (paginated GET /runs). The full
	// configSnapshot lives only on GET /runs/:id, which the list does not fetch.
	const getRequestInfo = () => {
		if (!run.summary) return { url: null, method: null };
		const url = run.summary.url || null;
		const method = run.summary.method || "GET";
		const type = run.summary.mode;
		// Requested protocol only - see design-run-seed.ts's doc comment for the
		// requested-vs-negotiated distinction. A load run's summary has no single
		// negotiated protocol to show (many exchanges, one requested setting).
		const httpVersion = run.summary.httpVersion;
		return { url, method, type, httpVersion };
	};

	const {
		url: requestUrl,
		method,
		type: loadTestType,
		httpVersion: requestedHttpVersion,
	} = getRequestInfo();
	const protocolLabel = isHttpVersion(requestedHttpVersion)
		? HTTP_VERSIONS.find((v) => v.value === requestedHttpVersion)?.label
		: undefined;

	/*
	 * A collection run has no url and no method - its work is a sequence - so
	 * every branch above leaves the row with a status and a timestamp and
	 * nothing else. `summary.scenario` is what it has instead: which collection
	 * ran, and how big the run was.
	 *
	 * Keyed off the summary rather than `run.type`, because the row can only
	 * render what the payload carries: a run recorded before the engine sent
	 * this key is still `type: "scenario"` and still has nothing to show, and
	 * falling back to the id-less shape is the honest answer for it.
	 *
	 * Not gated on `run.type === "scenario"` either, and that is the point: a
	 * scenario *load* run is `type: "load"` - it publishes ticks and reports
	 * percentiles like any load run - but it has no url and no method, for the
	 * same reason a collection run has none. Reading the descriptor wherever the
	 * summary offers one is what keeps its row from being a bare status.
	 */
	const scenario = run.summary?.scenario;
	// The name if the collection is still there, the id if it is not, and a
	// plain label if the run predates the descriptor. Never a blank line.
	const scenarioLabel = collectionName ?? scenario?.collectionId ?? null;

	// Get status icon and color
	const getStatusIcon = () => {
		switch (run.status) {
			case "completed":
				return <CheckCircle2 className="w-4 h-4 text-status-success-text" />;
			case "failed":
				return <XCircle className="w-4 h-4 text-status-error-text" />;
			case "running":
				return <Activity className="w-4 h-4 text-status-running-text animate-pulse" />;
			case "stopped":
				return <StopCircle className="w-4 h-4 text-status-stopped-text" />;
			default:
				return <Clock className="w-4 h-4 text-muted-foreground" />;
		}
	};

	return (
		<div
			className={cn(
				// focus-row: the card is the perceived target, so it paints the ring
				// for the activator inside it. It also has overflow-hidden, which
				// would clip an outset ring - focus-row's is inset.
				// `surface-card` + `border-rule`, not a hardcoded token. A run row
				// is a card, and `--border` on `--card` measures 1.003 in dark - the
				// same colour, so the row had no edge and separated only by the
				// card-on-panel step, itself 1.09. Declaring the surface resolves the
				// rule to 1.278 dark / 1.304 light; pinning `--border-strong` fixed
				// dark but pushed light to 1.553.
				"focus-row group relative surface-card border border-rule cursor-pointer transition-colors overflow-hidden w-full",
				isSelected
					? "bg-primary/10 hover:bg-primary/15 border-primary/50 ring-1 ring-inset ring-primary/20 shadow-sm"
					: "hover:border-primary/50 hover:shadow-sm"
			)}
		>
			{/* Status color indicator */}
			<div
				className={cn(
					"absolute left-0 top-0 bottom-0 w-1",
					run.status === "completed" && "bg-status-success",
					run.status === "failed" && "bg-status-error",
					run.status === "running" && "bg-status-running",
					run.status === "stopped" && "bg-status-stopped",
					run.status === "pending" && "bg-muted-foreground"
				)}
			/>

			<div className="pl-4 pr-3 py-3 min-w-0">
				{/* Header Row */}
				<div className="flex items-start justify-between gap-2 mb-2 min-w-0 flex-wrap">
					<div className="flex items-center gap-2 min-w-0 flex-1 flex-wrap">
						<div className="shrink-0">{getStatusIcon()}</div>
						<span
							className={cn(
								"text-xs font-medium capitalize shrink-0",
								run.status === "completed" && "text-status-success-text",
								run.status === "failed" && "text-status-error-text",
								run.status === "running" && "text-status-running-text",
								run.status === "stopped" && "text-status-stopped-text",
								run.status === "pending" && "text-muted-foreground"
							)}
						>
							{run.status}
						</span>
						<span className="text-xs text-muted-foreground shrink-0 hidden sm:inline">
							•
						</span>
						<span className="text-xs text-muted-foreground min-w-0 break-words">
							{formatTime(run.startTime)}
						</span>
						{/* `variant="chip"` because this badge paints its own
						    background: every other variant pairs `bg-x` with a
						    `hover:bg-x/80` that tailwind-merge would leave
						    behind, turning the chip the accent colour under the
						    pointer. */}
						{run.baseline && (
							<Badge
								variant="chip"
								className="shrink-0 gap-1 bg-primary/15 text-primary px-1.5 py-0 text-[10px] font-medium"
							>
								<Pin className="w-2.5 h-2.5" />
								Baseline
							</Badge>
						)}
					</div>
					{/* z-10: sits above the stretched activator below, so delete
					    stays clickable while the rest of the card selects the run. */}
					<div className="relative z-10 flex items-center gap-1 shrink-0">
						{/*
						 * This slot marks the run types whose *identity line* would
						 * otherwise be indistinguishable - which is load and design,
						 * and only those two. Both print a bare URL, so nothing else
						 * in the row separates a five-minute load test from a single
						 * send.
						 *
						 * A collection run deliberately has no badge here. Its
						 * identity is a folder name over a steps/iterations line, a
						 * shape no other run type produces, so a badge would be the
						 * third glyph in one small card saying the same thing -
						 * after the folder icon and the step count. It read as
						 * duplication because it was: the badge and the step count
						 * were the same glyph.
						 *
						 * The purple is raw palette, and stays: measured 3.93 light /
						 * 4.59 dark against the panel, so it clears the 3.0 icon bar
						 * in both themes, and there is no violet semantic token to
						 * move it to. Not every raw palette class is a defect.
						 */}
						{run.type === "load" && (
							<Zap className="w-3.5 h-3.5 text-purple-500 shrink-0" />
						)}
						{/*
						 * Pin as baseline. Offered for a load run and nothing
						 * else, because a baseline exists to be diffed and only
						 * a load run has a report with percentiles, throughput
						 * and an error rate to diff. A pinned run also stops
						 * being pruned, which is a promise worth making only
						 * where it buys something.
						 *
						 * Stays visible once pinned - the pin is state, not a
						 * hover affordance, and a row whose only sign of it
						 * vanished with the pointer would read as unpinned.
						 */}
						{onToggleBaseline && run.type === "load" && (
							<Button
								variant="rowAction"
								size="icon"
								onClick={(e) => onToggleBaseline(run.id, !run.baseline, e)}
								disabled={isTogglingBaseline}
								aria-label={run.baseline ? "Unpin baseline" : "Pin as baseline"}
								aria-pressed={!!run.baseline}
								title={
									run.baseline
										? "Unpin this run as the baseline"
										: "Pin this run as the baseline later runs are compared against"
								}
								className={cn(
									"h-6 w-6 transition-opacity",
									run.baseline || isTogglingBaseline
										? "opacity-100"
										: "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
								)}
							>
								{isTogglingBaseline ? (
									<Loader2 className="w-3 h-3 animate-spin" />
								) : run.baseline ? (
									<PinOff className="w-3 h-3" />
								) : (
									<Pin className="w-3 h-3" />
								)}
							</Button>
						)}
						<Button
							variant="rowActionDestructive"
							size="icon"
							onClick={(e) => onDelete(run.id, e)}
							disabled={isDeleting}
							aria-label={`Delete run`}
							className={cn(
								"h-6 w-6 transition-opacity",
								isDeleting
									? "opacity-100"
									: "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
							)}
						>
							{isDeleting ? (
								<Loader2 className="w-3 h-3 animate-spin" />
							) : (
								<Trash2 className="w-3 h-3" />
							)}
						</Button>
					</div>
				</div>

				{/* Request Info */}
				{requestUrl && (
					<div className="flex items-start gap-2 mb-1.5 min-w-0 flex-wrap">
						{method && <MethodBadge method={method} className="h-5 items-center" />}
						<p
							className="text-xs text-foreground font-medium break-words flex-1 min-w-0 leading-5"
							title={requestUrl}
						>
							{requestUrl}
						</p>
					</div>
				)}

				{/* What ran, for a run whose work is a sequence - the row's only
				    identity. Gated on the descriptor rather than on the run type,
				    so a scenario *load* run (`type: "load"`, no url, no method)
				    gets it too. */}
				{scenario && scenarioLabel && (
					<div className="flex items-start gap-2 mb-1.5 min-w-0">
						<Folder className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
						<p
							className="text-xs text-foreground font-medium break-words flex-1 min-w-0 leading-5"
							title={scenarioLabel}
						>
							{scenarioLabel}
						</p>
					</div>
				)}

				{scenario && (
					<div className="flex items-center gap-3 text-[10px] text-muted-foreground mt-1.5 flex-wrap">
						{scenario.stepCount != null && (
							<span className="flex items-center gap-1 shrink-0">
								<ListOrdered className="w-3 h-3" />
								{scenario.stepCount} step{scenario.stepCount === 1 ? "" : "s"}
							</span>
						)}
						{/* One pass is the default and saying so on every row is noise;
						    more than one is the thing that changes what the run was. */}
						{scenario.iterations != null && scenario.iterations > 1 && (
							<span className="flex items-center gap-1 shrink-0">
								<Repeat className="w-3 h-3" />
								{scenario.iterations} iterations
							</span>
						)}
						{scenario.recursive && (
							<span className="flex items-center gap-1 shrink-0">
								<FolderTree className="w-3 h-3" />
								Sub-folders
							</span>
						)}
					</div>
				)}

				{/* Config Info (if load test) */}
				{run.type === "load" && run.summary && (
					<div className="flex items-center gap-3 text-[10px] text-muted-foreground mt-1.5 flex-wrap">
						{run.summary.duration && (
							<span className="flex items-center gap-1 shrink-0">
								<Clock className="w-3 h-3" />
								{run.summary.duration}
							</span>
						)}
						{run.summary.concurrency && (
							<span className="flex items-center gap-1 shrink-0">
								<Activity className="w-3 h-3" />
								{formatConcurrency(run.summary.concurrency)}
							</span>
						)}
						{loadTestType && (
							<span className="flex items-center gap-1 shrink-0">
								<Zap className="w-3 h-3" />
								{loadTestTypeToLabel(loadTestType)}
							</span>
						)}
						{protocolLabel && (
							<span className="flex items-center gap-1 shrink-0">
								<Network className="w-3 h-3" />
								{protocolLabel}
							</span>
						)}
					</div>
				)}

				{/* Comment if exists */}
				{run.summary?.comment && (
					<p className="text-xs text-muted-foreground italic mt-1.5 break-words">
						"{run.summary.comment}"
					</p>
				)}
			</div>

			{/*
			 * The card used to be a <div onClick>: clickable by mouse, but not
			 * focusable, not in the tab order and not operable by Enter or Space.
			 * A keyboard user could reach "Delete run" inside a card but had no way
			 * to *open* one - the destructive action was reachable and the primary
			 * one was not.
			 *
			 * A stretched activator keeps the whole card clickable while being a
			 * real button. It is last in the DOM and absolutely positioned so it
			 * covers the content without disturbing layout; the actions group above
			 * carries z-10 to stay on top of it.
			 */}
			<button
				type="button"
				onClick={() => onSelect(run.id)}
				// Named by what it is. A collection run announced as a "request run"
				// with no url after it was a row a screen-reader user could not tell
				// apart from any other row in the list.
				aria-label={`Open ${RUN_KIND_LABEL[run.type]} run, ${run.status}${
					requestUrl ? `, ${requestUrl}` : scenarioLabel ? `, ${scenarioLabel}` : ""
				}`}
				className="absolute inset-0 z-0 cursor-pointer"
			/>
		</div>
	);
}
