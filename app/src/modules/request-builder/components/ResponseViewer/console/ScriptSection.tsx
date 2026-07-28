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
 */

import { useState } from "react";
import { AlertCircle, ChevronDown, ChevronRight, Terminal } from "lucide-react";
import { Badge, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { ParsedLog } from "./parse-logs";

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
				<h3
					className={cn(
						"text-xs font-medium",
						tone === "running" ? "text-status-running-text" : "text-status-success-text"
					)}
				>
					{label}
				</h3>
				<Badge
					variant="outline"
					className={cn(
						"ml-auto text-[10px]",
						tone === "running"
							? "border-status-running/30 text-status-running-text"
							: "border-status-success/30 text-status-success-text"
					)}
				>
					{logs.length} log{logs.length !== 1 ? "s" : ""}
				</Badge>
			</CollapsibleTrigger>
			<CollapsibleContent className="mt-2">
				<div className="surface-sunken p-3 rounded-md border border-rule font-mono text-xs space-y-1">
					{logs.map((log, i) => (
						<div key={i} className="flex items-start gap-2">
							<Terminal
								className={cn(
									"w-3.5 h-3.5 mt-px shrink-0",
									tone === "running"
										? "text-status-running-text"
										: "text-status-success-text"
								)}
							/>
							<pre className="text-foreground whitespace-pre-wrap break-words flex-1 min-w-0">
								{log.message}
							</pre>
						</div>
					))}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
