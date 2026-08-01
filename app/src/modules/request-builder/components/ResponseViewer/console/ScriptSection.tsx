/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One script's console output, and one script's error.
 *
 * `ConsoleOutput` was 212 lines and roughly 120 of them were two pairs of
 * near-identical blocks: the pre/post error cards, and the pre/test log
 * sections. Each pair differed in a status token, a heading, and nothing else -
 * the same shape as the script panels and the chain cards earlier in this
 * series, and with the same consequence, that a fix reaches one copy.
 *
 * The status colours are per-section rather than per-severity: pre-request logs
 * are `--status-running`, test logs `--status-success`. That is identity
 * colouring - which script spoke - not state, and it is why both take the
 * `-text` token for text and the bare token for tints, per the three-token rule.
 *
 * A *line* carries the other axis - which `console.*` method wrote it - and that
 * one is state, so it takes the status tokens for real. See `LEVEL_TONE`.
 */

import { useState } from "react";
import { useGrowingWindow } from "@/hooks/useGrowingWindow";
import { AlertCircle, ChevronDown, ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { ConsoleLevel } from "@/types";
import type { ParsedLog } from "./parse-logs";

/**
 * How each `console.*` level is drawn.
 *
 * `log` and `info` share the plain foreground on purpose - that is Chrome's
 * behaviour, and a fourth saturated tone inside a slab that already carries a
 * section colour would compete with it rather than inform. What separates them
 * is the gutter label, which is also what keeps this from being a colour-only
 * distinction: `warn` against `error` in a desaturated accent scheme is the
 * same failure the tab indicator exists to avoid.
 *
 * A blank gutter for `log` rather than the word "log": every ordinary line
 * would carry it, a column of noise saying what the absence of a marker already
 * says. The column is still reserved, so messages stay aligned.
 */
const LEVEL_TONE: Record<ConsoleLevel, { gutter: string; text: string; label: string }> = {
	log: { gutter: "", text: "text-foreground", label: "text-muted-foreground" },
	info: { gutter: "info", text: "text-foreground", label: "text-muted-foreground" },
	warn: { gutter: "warn", text: "text-status-warning-text", label: "text-status-warning-text" },
	error: { gutter: "error", text: "text-status-error-text", label: "text-status-error-text" },
};

/**
 * The two scripts, and the token each is drawn in.
 *
 * A table rather than a prop per colour, so adding a third source is one entry
 * and cannot half-land.
 */
export const SCRIPT_SECTIONS = {
	pre: { label: "Pre-request Script", errorLabel: "Pre-request Script Error", tone: "running" },
	test: { label: "Test Script", errorLabel: "Test Script Error", tone: "success" },
} as const;

export type ScriptKey = keyof typeof SCRIPT_SECTIONS;

/**
 * A script error.
 *
 * `--destructive` rather than the section's own tone: an error is state, not
 * identity, and it has to read as a failure whichever script raised it.
 */
export function ScriptError({ which, message }: { which: ScriptKey; message: string }) {
	return (
		<div className="p-3 rounded-md bg-destructive/10 border border-destructive/20">
			<div className="flex items-start gap-2">
				<AlertCircle className="w-3.5 h-3.5 text-destructive-text mt-0.5 shrink-0" />
				<div className="flex-1 min-w-0">
					<p className="text-xs font-semibold text-destructive-text">
						{SCRIPT_SECTIONS[which].errorLabel}
					</p>
					<pre className="text-xs text-status-error-text mt-1 font-mono whitespace-pre-wrap break-words overflow-x-auto">
						{message}
					</pre>
				</div>
			</div>
		</div>
	);
}

export function ScriptLogs({ which, logs }: { which: ScriptKey; logs: ParsedLog[] }) {
	const [open, setOpen] = useState(true);
	const { label, tone } = SCRIPT_SECTIONS[which];
	const { visible, sentinelRef, hasMore } = useGrowingWindow(logs.length);

	if (logs.length === 0) return null;

	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<CollapsibleTrigger className="flex items-center gap-2 w-full text-left group">
				{/*
				 * The tone tokens are interpolated into the class name, which is safe
				 * only because both values are literals in `SCRIPT_SECTIONS` - Tailwind
				 * scans source text, so a class assembled from a runtime string would
				 * generate nothing. That trap has bitten this codebase before
				 * (`bg-current/15`, `data-[state=on]:surface-card`), so the full class
				 * names are written out rather than built.
				 */}
				<div
					className={cn(
						"flex items-center justify-center w-4 h-4 rounded-md transition-colors",
						tone === "running"
							? "bg-status-running/20 group-hover:bg-status-running/30"
							: "bg-status-success/20 group-hover:bg-status-success/30"
					)}
				>
					{open ? (
						<ChevronDown
							className={cn(
								"w-3 h-3",
								tone === "running"
									? "text-status-running-text"
									: "text-status-success-text"
							)}
						/>
					) : (
						<ChevronRight
							className={cn(
								"w-3 h-3",
								tone === "running"
									? "text-status-running-text"
									: "text-status-success-text"
							)}
						/>
					)}
				</div>
				{/*
				 * No count badge. It restated what the section below shows, and on a
				 * short console - two lines, one per script - the row was mostly
				 * numbers about very little. The slab itself is the count.
				 */}
				<h3
					className={cn(
						"text-xs font-medium",
						tone === "running" ? "text-status-running-text" : "text-status-success-text"
					)}
				>
					{label}
				</h3>
			</CollapsibleTrigger>
			<CollapsibleContent className="mt-2">
				<div className="surface-sunken p-3 rounded-md border border-rule font-mono text-xs">
					{/*
					 * No per-line icon. Every line in this slab came from the script
					 * named in the heading directly above it, so a marker on each one
					 * repeated what the section already said - the same redundancy that
					 * took the icon off the Console tab trigger.
					 *
					 * It was also the dominant per-row cost: a lucide icon is a
					 * multi-element SVG, and console output is unbounded, so a script
					 * that logs in a loop was asking the pane to build one SVG per
					 * line. Removing it is worth more here than anywhere else in the
					 * pane.
					 */}
					{logs.slice(0, visible).map((log, i) => {
						const tone = LEVEL_TONE[log.level];
						return (
							<div key={i} className="skip-offscreen flex gap-2 py-px">
								{/*
								 * A span, not an icon - see the note above about what a
								 * per-row SVG costs on unbounded output. One text node, and
								 * it says more than a shape would.
								 */}
								<span
									aria-hidden={tone.gutter === "" ? true : undefined}
									className={cn(
										"w-9 shrink-0 select-none text-right text-[10px] uppercase leading-5 tracking-wide",
										tone.label
									)}
								>
									{tone.gutter}
								</span>
								<pre
									className={cn(
										"min-w-0 flex-1 whitespace-pre-wrap break-words",
										tone.text
									)}
								>
									{log.message}
								</pre>
							</div>
						);
					})}
					{hasMore && (
						/*
						 * The sentinel. Reaching it renders the next slice - nothing is
						 * withheld, it just arrives when you get there. The count is
						 * stated rather than left to be inferred from a scrollbar.
						 */
						<div
							ref={sentinelRef}
							className="pt-2 text-[10px] text-muted-foreground tabular-nums"
						>
							Showing {visible.toLocaleString()} of {logs.length.toLocaleString()}…
						</div>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
