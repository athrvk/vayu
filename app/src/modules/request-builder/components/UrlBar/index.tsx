/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One row: the method and URL as one field, then Send and Load Test as an attached pair.
 *
 * - **The method sits inside the URL field's border**: verb and address are one thought, as a
 *   browser's protocol chip is, and a separate dropdown sized for OPTIONS wasted ~40px on every GET
 *   plus a border and a gap.
 * - **Send and Load Test are attached.** A filled button joined to an outlined one usually reads as
 *   a seam between materials; here both are the accent (Send `--primary-fill` with a white label,
 *   Load Test `--primary` at 12% with `--primary-text`), so the join is a step in weight within one
 *   colour. The shared edge is Load Test's own border with a transparent left, keeping both heights
 *   equal with no doubled line.
 * - **Both shortcuts show on hover**, from `constants/shortcuts.ts`, so label and handler agree.
 * - **Controls are `h-control`** (#1679). `h-8` looked like the app's step but resolved to 27px,
 *   not 28px, once `--spacing` moved to the 3px rhythm (#1670). The row states its floor,
 *   `min-h-band-md` (40px, #1688), rather than a control height plus padding that could drift.
 * - **No icons and no inline keycaps**: in the one row without spare width, each icon cost ~20px
 *   and a `Ctrl+Shift+↵` cap ~70px on a nine-character label (the pair is ~140px, against ~186px);
 *   a tooltip carries the chord free. A running state keeps one pulsing dot: a live run is the one
 *   thing a static colour cannot say.
 */

import { useEffect, useState } from "react";

import { useRequestBuilderContext } from "../../context";
import { runningRunTab, useCanStartLoadRun, useTabsStore, type RunningRun } from "@/stores";
import {
	DialogCancelButton,
	Tooltip,
	TooltipContent,
	TooltipShortcutLabel,
	TooltipTrigger,
	LabelSwap,
} from "@/components/ui";
import { formatChord, type Chord } from "@/lib/platform";
import { SEND_CHORD, LOAD_TEST_CHORD } from "@/constants/shortcuts";
import { cn } from "@/lib/utils";
import MethodSelector from "./MethodSelector";
import SendWithRowDialog from "./SendWithRowDialog";
import UrlInput from "./UrlInput";

/**
 * A button plus its shortcut, on hover. A keycap inside the button made it far too wide
 * (`Ctrl+Shift+↵` is eleven characters on a nine-character label, in a row short of URL width); a
 * tooltip costs nothing and is where shortcuts live. Not `Kbd`: a keycap for `--muted` on a panel,
 * while `TooltipContent` paints `--primary-fill` with a white label, so it would be a grey chip on
 * the accent. `TooltipHint` is the one tint that reads there; a hand-written 70% alpha measured
 * 2.50:1 on Sunset (`tooltip-hint-contrast.test.ts`).
 */
export function Hint({
	chord,
	label,
	children,
}: {
	chord: Chord;
	label: string;
	children: React.ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent side="bottom">
				<TooltipShortcutLabel label={label} shortcut={formatChord(chord)} />
			</TooltipContent>
		</Tooltip>
	);
}

/** The running-run shortcut's label: the dashboard's run, or a collection run's tab. */
function viewRunningRunLabel(running: RunningRun): string {
	return running.kind === "load" ? "View load test" : "View collection run";
}

export default function UrlBar() {
	const {
		request,
		isExecuting,
		canCancelSend,
		cancelSend,
		isStreaming,
		stopStream,
		executeRequest,
		startLoadTest,
		canStartLoadTest,
		sendWithRow: rows,
		lastRowIndex,
		rememberRowIndex,
	} = useRequestBuilderContext();
	// The builder's Load test asks this same gate, so the button never offers a start a click would
	// refuse.
	const loadRunGate = useCanStartLoadRun();
	const runningRun = loadRunGate.ok ? null : loadRunGate.running;
	const openTab = useTabsStore((s) => s.openTab);

	/*
	 * A collection-run step pointed here (#730): "Repro row 501" opened this request, and the row
	 * travels in the tabs store since `openTab` names only a request. Acting on it selects the row
	 * and opens the list on it, so the failing step is one click from resending. Taken once: it
	 * must survive the tab's first open, and a later visit must not reopen the list on an old
	 * choice. Taken whether or not the request binds rows (outside a data-driven collection there
	 * is no picker).
	 */
	const [rowMenuOpen, setRowMenuOpen] = useState(false);
	const dataRowRequested = useTabsStore(
		(s) => s.navIntent?.kind === "dataRow" && s.navIntent.target === request.id
	);
	const takeNavIntent = useTabsStore((s) => s.takeNavIntent);
	// The caret's condition (`showRowCaret`): with a stream open Send is Stop, with no picker.
	const canBindRows = rows.available && !isStreaming;
	useEffect(() => {
		if (!dataRowRequested || !request.id) return;
		const intent = takeNavIntent("dataRow", request.id);
		if (!intent) return;
		rememberRowIndex(intent.rowIndex);
		/* eslint-disable-next-line react-hooks/set-state-in-effect -- the intent
		   is state handed over from a navigation, not derived from a prop: it
		   arrives before this tab renders and is taken once. */
		if (canBindRows) setRowMenuOpen(true);
	}, [dataRowRequested, request.id, canBindRows, takeNavIntent, rememberRowIndex]);

	const canExecute = !isExecuting && request.url.trim().length > 0;

	/*
	 * Send owns both outer corners when alone in the group. `canStartLoadTest` is false for a
	 * detached past design run, so the second member is absent, and a lone member with a square
	 * right edge looks broken; UrlBar.test.tsx guards this easily missed state. The row caret is a
	 * third possible member and takes Send's right corner, so the rule is "Send is alone", not "no
	 * Load Test".
	 */
	const showRowCaret = canBindRows;
	const sendAlone = !canStartLoadTest && !showRowCaret;

	return (
		<div className="flex min-h-band-md flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1 border-b border-rule bg-panel shrink-0">
			{/*
			 * One field for method and URL, on `border-input`, not `border-border`: `--input`
			 * exists so a field has an edge, and `--border` on `--card` measured **1.003**, leaving
			 * the most-used control without a visible boundary in dark mode beyond the 1.09
			 * card-on-panel step.
			 */}
			<div
				className={cn(
					// `bg-card surface-card`, the pair: `surface-card` sets the background *and*
					// declares `--rule`, but a `bg-*` utility beside it wins the cascade, so both
					// are written (docs/design-system/feedback-and-dashboard.md); the separator
					// below inherits `--rule`. `min-w-[12rem]` is the field's floor (#3494): below
					// it the Send group wraps (the row is `flex-wrap`) rather than squeezing the
					// URL to a sliver in a narrow pane or at 200% scale.
					"flex flex-1 min-w-[12rem] items-center h-control rounded-md bg-card surface-card",
					"border border-input transition-colors focus-within:border-primary"
				)}
			>
				<MethodSelector />
				{/*
				 * The hairline between the field's halves. `border-rule`, not `bg-border`: on
				 * `--card`, `--border` *is* `--card` in dark (1.01, absent) while 1.30 in light,
				 * the asymmetry the surface/rule contract removes; `surface-card` resolves `--rule`
				 * to `--border` in light and `--border-strong` in dark, so 1.30 / 1.27. `h-5`, not
				 * full height: a full rule reads as a wall between two controls.
				 */}
				<span aria-hidden="true" className="h-5 w-0 shrink-0 border-l border-rule" />
				<UrlInput className="flex-1 min-w-0 h-full border-0 bg-transparent px-3 text-sm font-mono shadow-none rounded-none focus-within:ring-0" />
			</div>

			{/*
			 * Cancel for a buffered send in flight (#3352), beside the disabled Send, not in its
			 * place: the pair keeps its position, so a second press aimed at Send cannot hit
			 * Cancel. Click-only, like Stop. `DialogCancelButton`, the one control that draws the
			 * word (`dialog-cancel.test.ts`), at the pair's type size.
			 */}
			{canCancelSend && (
				<DialogCancelButton
					onClick={cancelSend}
					className="shrink-0 text-xs font-semibold"
				/>
			)}

			{/*
			 * Send + Load Test, attached. Corner rules are per member, not on the group, since the
			 * group has a one-member state.
			 */}
			<div className="flex shrink-0">
				{/*
				 * While a stream is open, Send *is* Stop (#574): a stream ends by being stopped or
				 * by an engine bound, and sending again would replace the very run you would stop.
				 * So one control does the one action, on the error tokens (a destructive verb),
				 * with the load button's live dot (a stream is *live*). The chord follows the
				 * button (#935): inert while streaming, as `RequestBuilderLayout`'s handler gates
				 * on `isStreaming`. No `Hint`: Stop is deliberately click-only, being destructive.
				 */}
				{isStreaming ? (
					<button
						onClick={() => void stopStream()}
						className={cn(
							"h-control px-4 inline-flex items-center gap-1.5 shrink-0",
							"text-xs font-semibold font-[inherit] transition-colors",
							"text-status-error-text bg-status-error/10 hover:bg-status-error/20",
							"border border-status-error/40",
							sendAlone ? "rounded-md" : "rounded-l-md rounded-r-none"
						)}
					>
						<span
							aria-hidden="true"
							className="size-1.5 rounded-full bg-status-error animate-pulse"
						/>
						Stop
					</button>
				) : (
					<Hint chord={SEND_CHORD} label="Send request">
						<button
							onClick={() => void executeRequest()}
							disabled={!canExecute}
							// `LabelSwap` renders through a keyed child the icon-button-labels scan
							// cannot see past, so the button reads name-less to the scan though a
							// screen reader announces it. The label mirrors the visible text,
							// adding no copy.
							aria-label={isExecuting ? "Sending…" : "Send"}
							className={cn(
								"h-control px-4 inline-flex items-center gap-1.5 shrink-0",
								"bg-primary-fill text-white text-xs font-semibold font-[inherit]",
								"border border-primary-fill",
								/*
								 * `hover:bg-primary-fill-hover` is the `Button` primitive's
								 * `default` variant; these are hand-rolled to share an edge, so
								 * they carry the convention rather than inherit it. The border
								 * moves with the fill, or a lighter ring shows around a darkening
								 * button.
								 */
								"hover:bg-primary-fill-hover hover:border-primary-fill-hover",
								"disabled:opacity-50 disabled:hover:bg-primary-fill",
								// Hand-rolled, so without `[data-slot="button"]` it misses the
								// baseline's `scale` press feedback, added here at the colours'
								// duration rather than the baseline's 100ms: a separate `scale`
								// duration needs a second `transition-property` utility, and two on
								// one element replace each other silently.
								"transition-[background-color,color,border-color,opacity,scale] duration-150 active:scale-[0.98]",
								sendAlone ? "rounded-md" : "rounded-l-md rounded-r-none"
							)}
						>
							<LabelSwap
								label={isExecuting ? "Sending…" : "Send"}
								states={["Send", "Sending…"]}
							/>
						</button>
					</Hint>
				)}

				{/*
				 * Send's caret: the same verb bound to one row of the collection's data file. Only
				 * with a contract and a declared file in scope, never while streaming: Send is
				 * Stop, and a caret would offer to start what it ends.
				 */}
				{showRowCaret && (
					<SendWithRowDialog
						rows={rows}
						onSend={(row) => void executeRequest(row)}
						disabled={!canExecute}
						lastInGroup={!canStartLoadTest}
						lastRowIndex={lastRowIndex}
						onRowIndexChange={rememberRowIndex}
						open={rowMenuOpen}
						onOpenChange={setRowMenuOpen}
					/>
				)}

				{/*
				 * Hidden when the builder cannot load test (a detached past design run): even a
				 * disabled button would mislead.
				 */}
				{canStartLoadTest &&
					(runningRun ? (
						/*
						 * While a run holds the stream this is a shortcut to it (gate:
						 * `canStartLoadRun`), on the status tokens, not the accent: it reports a
						 * state rather than offering the action, and colour says so.
						 */
						<button
							onClick={() => openTab(runningRunTab(runningRun))}
							className={cn(
								"h-control px-3.5 inline-flex items-center gap-1.5 shrink-0",
								"text-xs font-semibold font-[inherit] transition-colors",
								"text-status-success-text bg-status-success/10 hover:bg-status-success/20",
								"border border-status-success/40 border-l-transparent",
								"rounded-r-md rounded-l-none"
							)}
						>
							{/*
							 * The one mark kept: a run is *live*, and a static green tint does not
							 * say so.
							 */}
							<span
								aria-hidden="true"
								className="size-1.5 rounded-full bg-status-success animate-pulse"
							/>
							{viewRunningRunLabel(runningRun)}
						</button>
					) : (
						<Hint chord={LOAD_TEST_CHORD} label="Start a load test">
							<button
								onClick={startLoadTest}
								disabled={!canExecute}
								className={cn(
									"h-control px-4 inline-flex items-center shrink-0",
									"text-xs font-semibold font-[inherit]",
									// A tint steps *up*: `--primary-tint` to `--primary-tint-hover`
									// is the "one more step of itself" `--primary-fill-hover` gives
									// the fill. Opaque tokens, not an accent alpha: the label sits
									// on it, and an alpha lands wherever the accent puts it.
									"text-primary-text bg-primary-tint hover:bg-primary-tint-hover",
									// The join: this member's border with the shared edge
									// transparent; two adjacent 1px borders would draw 2px and make
									// the pair a pixel taller than Send.
									"border border-primary/45 border-l-transparent",
									"rounded-r-md rounded-l-none",
									"disabled:opacity-50 disabled:hover:bg-primary-tint",
									// Hand-rolled like Send; see Send's comment for why `scale`
									// shares its transition-property.
									"transition-[background-color,color,border-color,opacity,scale] duration-150 active:scale-[0.98]"
								)}
							>
								Load test
							</button>
						</Hint>
					))}
			</div>
		</div>
	);
}
