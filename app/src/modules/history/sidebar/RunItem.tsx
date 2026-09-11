/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type React from "react";
import { loadTestTypeToLabel } from "@/constants/load-test-modes";
import type { Run } from "@/types";
import { RUN_KIND_LABEL } from "@/modules/history/types";
import { Badge, Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { MethodBadge, RowContextMenu, type RowAction } from "@/components/shared";
import { DEFAULT_REQUEST_NAME, HTTP_VERSIONS, isHttpVersion } from "@/constants/request";
import { formatConcurrency } from "@/constants/load-test-modes";
import {
	Activity,
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
	AlertTriangle,
} from "lucide-react";

/**
 * One dot colour per status - the row's only status affordance now.
 * The word and the left-edge bar this used to carry are gone: `formatTime`'s
 * per-row relative timestamp repeated "8h ago" down a whole page of rows and,
 * with a card border and `py-3` around it, the pair cost roughly two lines of
 * dead space per row for information a day-group header (`HistoryList.tsx`'s
 * `groupRunsByDay`) or a hover now carries instead. The full word and the
 * exact timestamp are still there, in the row's `title`.
 */
const STATUS_DOT_CLASS: Record<Run["status"], string> = {
	completed: "bg-status-success",
	failed: "bg-status-error",
	running: "bg-status-running animate-pulse",
	stopped: "bg-status-stopped",
	pending: "bg-muted-foreground",
};

const STATUS_LABEL: Record<Run["status"], string> = {
	completed: "Completed",
	failed: "Failed",
	running: "Running",
	stopped: "Stopped",
	pending: "Pending",
};

interface RunItemProps {
	run: Run;
	onSelect: (runId: string) => void;
	/**
	 * The event is the row's, and is only there to be stopped: a click on the
	 * button must not also reach the card's activator behind it. The row menu
	 * (#1360) calls the same handler with none, because a menu selection is not
	 * a click on the row.
	 */
	onDelete: (runId: string, event?: React.MouseEvent) => void;
	/**
	 * Pin or unpin this run. Every run type can be pinned - it keeps the run
	 * past retention and finds it again under the Pinned filter. A load run's
	 * pin is additionally its request's comparison baseline, which is why the
	 * label differs by type - see the action's own comment.
	 */
	onToggleBaseline?: (runId: string, baseline: boolean, event?: React.MouseEvent) => void;
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
	 * A proper name over a raw URL, when the run recorded one worth showing.
	 * `requestName` is the request's name *as the client sent it at run
	 * start* (see `RunSummary.requestName`'s doc comment) - never
	 * re-read from the requests table - so a request renamed or deleted since
	 * does not retroactively change what a past run says it invoked.
	 *
	 * Excluded when it is still the default: "New Request" identifies nothing
	 * a bare URL does not already say better, and every request starts out
	 * named that until a user changes it - showing it here would mean most
	 * rows traded a URL for a name that means "unnamed".
	 */
	const requestName =
		run.summary?.requestName && run.summary.requestName !== DEFAULT_REQUEST_NAME
			? run.summary.requestName
			: null;

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

	// A load run's pin is also its request's comparison baseline, so it keeps
	// the more specific label; every other type just gets "Pin"/"Unpin".
	const isLoadRun = run.type === "load";
	const pinActionLabel = run.baseline
		? isLoadRun
			? "Unpin baseline"
			: "Unpin"
		: isLoadRun
			? "Pin as baseline"
			: "Pin";
	const pinTooltip = run.baseline
		? isLoadRun
			? "Unpin this run as the baseline"
			: "Unpin this run"
		: isLoadRun
			? "Pin this run as the baseline later runs are compared against"
			: "Pin this run to keep it past retention and find it again later";

	/*
	 * The row's actions, offered on right-click (#1360). The same two handlers
	 * the buttons above call - the pin and the delete are defined once, by the
	 * list that owns them, and this is a second way to reach them rather than a
	 * second definition of what they do.
	 */
	const rowActions: RowAction[] = [
		...(onToggleBaseline
			? [
					{
						label: pinActionLabel,
						icon: run.baseline ? PinOff : Pin,
						onSelect: () => onToggleBaseline(run.id, !run.baseline),
						disabled: isTogglingBaseline,
					},
				]
			: []),
		{
			label: "Delete run",
			icon: Trash2,
			onSelect: () => onDelete(run.id),
			destructive: true,
			disabled: isDeleting,
		},
	];

	// The status word and the exact timestamp - said once, in the tooltip,
	// rather than on every row (the day-group header above the row already
	// says which day; a relative "8h ago" repeated down the whole list said
	// nothing a hover can't say instead). The comment joins it here too: it's
	// occasional, not the row's identity, so it earns a hover rather than a
	// permanent line.
	const rowTitle = [
		`${STATUS_LABEL[run.status]} · ${
			run.startTime ? new Date(run.startTime).toLocaleString() : "Unknown time"
		}`,
		run.summary?.comment && `"${run.summary.comment}"`,
	]
		.filter(Boolean)
		.join(" — ");

	// A bare fallback identity for the rare row with neither a url nor a
	// scenario descriptor (a run recorded before either existed, or one still
	// pending). Never a blank line where the method/name would be.
	const fallbackIdentity = RUN_KIND_LABEL[run.type];

	// The row's identity text, in priority order: a proper request name, else
	// the url, else the collection a scenario ran, else the bare fallback.
	const identitySuffix = requestName ?? requestUrl ?? scenarioLabel;
	const identityText = identitySuffix ?? fallbackIdentity;
	// A name replacing the url as the visible text does not hide the url -
	// it is one hover away, on the same text, the way a truncated url or
	// collection name already was.
	const identityTitle = requestName ? (requestUrl ?? undefined) : (identitySuffix ?? undefined);

	const hasMeta =
		(scenario &&
			(scenario.stepCount != null ||
				(scenario.iterations != null && scenario.iterations > 1) ||
				scenario.recursive)) ||
		(run.type === "load" &&
			run.summary &&
			(run.summary.duration || run.summary.concurrency || loadTestType || protocolLabel));

	return (
		<RowContextMenu label="More actions for this run" actions={rowActions}>
			<div
				className={cn(
					// focus-row: the row is the perceived target, so it paints the
					// ring for the stretched activator inside it - see RequestItem.tsx,
					// whose h-8/flat/hover-fill shape this row now shares rather than
					// the bordered card every row used to be.
					//
					// `transition-[background-color,border-color,box-shadow]`, not the
					// bare `transition-colors` utility: `isSelected` below toggles a
					// `ring-1` (a box-shadow), which `transition-colors` does not cover,
					// so the selected state would snap rather than fade in.
					"focus-row group relative flex flex-col gap-1 rounded-md px-2 py-1.5 cursor-pointer transition-[background-color,border-color,box-shadow]",
					isSelected
						? "bg-primary/10 ring-1 ring-inset ring-primary/20 hover:bg-primary/15"
						: "hover:bg-accent"
				)}
				title={rowTitle}
			>
				{/* Identity line - one row: status dot, method (or a folder icon for
				    a run whose work is a sequence), path or collection name, then
				    the badges and actions a hover or a pinned/warned state reveals. */}
				<div className="flex h-5 min-w-0 items-center gap-2">
					<span
						className={cn(
							"h-2 w-2 shrink-0 rounded-full",
							STATUS_DOT_CLASS[run.status]
						)}
						aria-hidden="true"
					/>
					{method ? (
						<MethodBadge
							method={method}
							variant="text"
							size="sm"
							className="w-[5ch] shrink-0"
						/>
					) : scenario ? (
						<Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
					) : null}
					<span
						className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
						title={identityTitle}
					>
						{identityText}
					</span>
					{/* `variant="chip"` because this badge paints its own background:
					    every other variant pairs `bg-x` with a `hover:bg-x/80` that
					    tailwind-merge would leave behind, turning the chip the accent
					    colour under the pointer. */}
					{run.baseline && (
						<Badge
							variant="chip"
							className="shrink-0 gap-1 bg-primary/15 px-1.5 py-0 text-[10px] font-semibold text-primary"
						>
							<Pin className="h-2.5 w-2.5" />
							{isLoadRun ? "Baseline" : "Pinned"}
						</Badge>
					)}
					{/* #1527: the run finished with something to say - an unresolved
					    variable, a pre-request script the load path skipped - that
					    only its full report shows. No adjacent text carries this, so
					    the icon names itself. */}
					{run.summary?.hasWarnings && (
						<AlertTriangle
							className="h-3.5 w-3.5 shrink-0 text-warning-text"
							role="img"
							aria-label="This run has warnings - see its report"
						/>
					)}
					{/*
					 * This slot marks the run types whose identity line would
					 * otherwise be indistinguishable - which is load and design, and
					 * only those two. Both print a bare URL, so nothing else in the
					 * row separates a five-minute load test from a single send.
					 *
					 * A collection run deliberately has no badge here. Its identity
					 * is a folder icon and a name, a shape no other run type
					 * produces, so a badge would be a second glyph saying the same
					 * thing the folder icon already says.
					 *
					 * The purple is raw palette, and stays: measured 3.93 light /
					 * 4.59 dark against the panel, so it clears the 3.0 icon bar in
					 * both themes, and there is no violet semantic token to move it
					 * to. Not every raw palette class is a defect.
					 */}
					{run.type === "load" && (
						<Zap className="h-3.5 w-3.5 shrink-0 text-purple-500" />
					)}
					{/* z-10: sits above the stretched activator below, so these stay
					    clickable while the rest of the row selects the run. */}
					<div className="relative z-10 flex shrink-0 items-center gap-1">
						{/*
						 * Pin this run. Every run type gets it: pinning keeps the run
						 * past retention and finds it again under the Pinned filter.
						 * A load run's pin is additionally its request's comparison
						 * baseline, hence the label difference above
						 * (pinActionLabel/pinTooltip).
						 *
						 * Stays visible once pinned - the pin is state, not a hover
						 * affordance, and a row whose only sign of it vanished with
						 * the pointer would read as unpinned.
						 */}
						{onToggleBaseline && (
							<Button
								variant="rowAction"
								size="icon"
								onClick={(e) => onToggleBaseline(run.id, !run.baseline, e)}
								disabled={isTogglingBaseline}
								aria-label={pinActionLabel}
								aria-pressed={!!run.baseline}
								title={pinTooltip}
								className={cn(
									"h-6 w-6 transition-opacity",
									run.baseline || isTogglingBaseline
										? "opacity-100"
										: "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
								)}
							>
								{isTogglingBaseline ? (
									<Loader2 className="h-3 w-3 animate-spin" />
								) : run.baseline ? (
									<PinOff className="h-3 w-3" />
								) : (
									<Pin className="h-3 w-3" />
								)}
							</Button>
						)}
						<Button
							variant="rowActionDestructive"
							size="icon"
							onClick={(e) => onDelete(run.id, e)}
							disabled={isDeleting}
							aria-label="Delete run"
							className={cn(
								"h-6 w-6 transition-opacity",
								isDeleting
									? "opacity-100"
									: "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
							)}
						>
							{isDeleting ? (
								<Loader2 className="h-3 w-3 animate-spin" />
							) : (
								<Trash2 className="h-3 w-3" />
							)}
						</Button>
					</div>
				</div>

				{/* Meta line(s) - unchanged content, one line tighter than before.
				    A collection run's step/iteration/sub-folder facts, or a load
				    run's duration/concurrency/type/protocol; never both, since
				    scenario and run.type === "load" && summary are mutually
				    exclusive in what they read. Omitted entirely rather than an
				    empty `pl-[1.625rem]` row when neither applies. */}
				{hasMeta && (
					<div className="flex flex-wrap items-center gap-3 pl-[1.625rem] text-[10px] text-muted-foreground">
						{scenario?.stepCount != null && (
							<span className="flex shrink-0 items-center gap-1">
								<ListOrdered className="h-3 w-3" />
								{scenario.stepCount} step{scenario.stepCount === 1 ? "" : "s"}
							</span>
						)}
						{/* One pass is the default and saying so on every row is noise;
					    more than one is the thing that changes what the run was. */}
						{scenario?.iterations != null && scenario.iterations > 1 && (
							<span className="flex shrink-0 items-center gap-1">
								<Repeat className="h-3 w-3" />
								{scenario.iterations} iterations
							</span>
						)}
						{scenario?.recursive && (
							<span className="flex shrink-0 items-center gap-1">
								<FolderTree className="h-3 w-3" />
								Sub-folders
							</span>
						)}
						{run.type === "load" && run.summary?.duration && (
							<span className="flex shrink-0 items-center gap-1">
								<Clock className="h-3 w-3" />
								{run.summary.duration}
							</span>
						)}
						{run.type === "load" && run.summary?.concurrency && (
							<span className="flex shrink-0 items-center gap-1">
								<Activity className="h-3 w-3" />
								{formatConcurrency(run.summary.concurrency)}
							</span>
						)}
						{run.type === "load" && loadTestType && (
							<span className="flex shrink-0 items-center gap-1">
								<Zap className="h-3 w-3" />
								{loadTestTypeToLabel(loadTestType)}
							</span>
						)}
						{run.type === "load" && protocolLabel && (
							<span className="flex shrink-0 items-center gap-1">
								<Network className="h-3 w-3" />
								{protocolLabel}
							</span>
						)}
					</div>
				)}

				{/*
				 * The row used to be a <div onClick>: clickable by mouse, but not
				 * focusable, not in the tab order and not operable by Enter or Space.
				 * A keyboard user could reach "Delete run" inside a row but had no way
				 * to *open* one - the destructive action was reachable and the primary
				 * one was not.
				 *
				 * A stretched activator keeps the whole row clickable while being a
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
						identitySuffix ? `, ${identitySuffix}` : ""
					}`}
					className="absolute inset-0 z-0 cursor-pointer"
					// Marks this button as one stop of `useHistoryListFocus`'s roving
					// tabindex - one Tab stop for the whole list, Up/Down/Home/End move
					// it. Starts at -1; the hook promotes exactly one to 0, the same
					// shape `useRovingTreeFocus` uses for the collection tree. A real
					// `<button>` already activates on Enter/Space with no handler of
					// the hook's own, unlike a tree row (a div wrapping its own
					// activate button), so nothing else here has to change.
					data-history-activate
					tabIndex={-1}
				/>
			</div>
		</RowContextMenu>
	);
}
