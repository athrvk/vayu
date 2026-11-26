/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One script's console output and one script's error, each rendered per script, so a fix reaches
 * both. Section colours are per script, not per severity: pre-request logs `--status-running`, test
 * logs `--status-success`. That is identity (which script spoke), not state, hence the `-text`
 * token for text and the bare one for tints (the three-token rule). A *line*'s colour is the other
 * axis, the `console.*` method, which is state and takes the status tokens for real (`LEVEL_TONE`,
 * `components/shared/console-level.ts`). A row may be a script request (#3633, `console-rows.ts`),
 * drawn as the expandable `ScriptRequestRow` in the same window.
 */

import { useState } from "react";
import { useGrowingWindow } from "@/hooks/useGrowingWindow";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Callout } from "@/components/shared";
import { LEVEL_TONE } from "@/components/shared/console-level";
import { LogGutter } from "@/components/shared/LogGutter";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Heading } from "@/components/ui/heading";
import { ScriptRequestRow } from "@/components/shared/response-viewer/ScriptRequestRow";
import { isScriptRequestRow, type ConsoleRow, type ScriptRequestConsoleRow } from "./console-rows";
import { SCRIPT_SECTIONS, type ScriptKey } from "./script-sections";
import ScopeTag from "../ScopeTag";

/**
 * A script error, as a `blocking` Callout, not the section's tone: an error is state and must read
 * as failure whichever script raised it.
 */
export function ScriptError({ which, message }: { which: ScriptKey; message: string }) {
	return (
		<Callout severity="blocking">
			<span className="font-semibold">{SCRIPT_SECTIONS[which].errorLabel}</span>
			<pre className="mt-1 block font-mono whitespace-pre-wrap break-words overflow-x-auto">
				{message}
			</pre>
		</Callout>
	);
}

/** A request row, where the line it stands in for (if any) would have been. */
function ScriptRequestLine({ row }: { row: ScriptRequestConsoleRow }) {
	return (
		<div className="skip-offscreen flex gap-2 py-px">
			<LogGutter label="" labelClassName={LEVEL_TONE.info.label} />
			<ScopeTag scope={row.scope} className="leading-5" />
			<ScriptRequestRow record={row.record} className="flex-1" />
		</div>
	);
}

export function ScriptLogs({ which, logs }: { which: ScriptKey; logs: ConsoleRow[] }) {
	const [open, setOpen] = useState(true);
	const { label, tone } = SCRIPT_SECTIONS[which];
	const { visible, sentinelRef, hasMore } = useGrowingWindow(logs.length);

	if (logs.length === 0) return null;

	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<CollapsibleTrigger className="flex items-center gap-2 w-full text-left group">
				{/*
				 * The tone tokens are interpolated into the class name, safe only because both are
				 * literals in `SCRIPT_SECTIONS`: Tailwind scans source text, so a class built from
				 * a runtime string generates nothing (this bit before: `bg-current/15`,
				 * `data-[state=on]:surface-card`). So full class names are written out.
				 */}
				<div
					className={cn(
						"flex items-center justify-center size-icon rounded-md transition-colors",
						tone === "running"
							? "bg-status-running/20 group-hover:bg-status-running/30"
							: "bg-status-success/20 group-hover:bg-status-success/30"
					)}
				>
					{open ? (
						<ChevronDown
							className={cn(
								"size-icon-sm",
								tone === "running"
									? "text-status-running-text"
									: "text-status-success-text"
							)}
						/>
					) : (
						<ChevronRight
							className={cn(
								"size-icon-sm",
								tone === "running"
									? "text-status-running-text"
									: "text-status-success-text"
							)}
						/>
					)}
				</div>
				{/* No count badge: it restated the section, and the slab is the count. */}
				{/* The level is the host's: the response pane, a run's step in History. */}
				<Heading
					outside="h3"
					className={cn(
						"text-xs font-medium",
						tone === "running" ? "text-status-running-text" : "text-status-success-text"
					)}
				>
					{label}
				</Heading>
			</CollapsibleTrigger>
			<CollapsibleContent className="mt-2">
				<div className="surface-sunken p-3 rounded-md border border-rule font-mono text-xs">
					{/*
					 * No per-line icon: every line came from the script in the heading above, so it
					 * repeated the section. It was also the dominant per-row cost: a lucide icon is
					 * a multi-element SVG and console output is unbounded, so a script logging in a
					 * loop built one SVG per line.
					 */}
					{logs.slice(0, visible).map((log, i) => {
						if (isScriptRequestRow(log)) return <ScriptRequestLine key={i} row={log} />;
						const tone = LEVEL_TONE[log.level];
						return (
							<div key={i} className="skip-offscreen flex gap-2 py-px">
								<LogGutter label={tone.gutter} labelClassName={tone.label} />
								<ScopeTag scope={log.scope} className="leading-5" />
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
						 * The sentinel: reaching it renders the next slice (nothing withheld, it
						 * arrives when reached). The count is stated, not left to a scrollbar.
						 */
						<div
							ref={sentinelRef}
							className="pt-2 text-micro text-muted-foreground tabular-nums"
						>
							Showing {visible.toLocaleString()} of {logs.length.toLocaleString()}…
						</div>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
