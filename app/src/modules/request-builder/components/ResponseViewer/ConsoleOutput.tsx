/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ConsoleOutput Component
 *
 * Displays console logs separated by pre-scripts and tests.
 *
 * The four boxes here - two error cards, two log slabs - were the module's
 * square-corner cluster: no radius class at all, so they stayed sharp at every
 * Roundedness setting while their neighbours followed it.
 *
 * The log slabs also dropped `border border-border`. Measured in the running
 * app, no border token outlines a `bg-muted` box in both themes:
 *
 *                                  light    dark
 *     --border       on --muted    1.105    1.157
 *     --border-strong on --muted   1.317    1.108
 *
 * `--border-strong` is the usual escape hatch on `--card` - it is what fixed the
 * URL bar and the history rows - and here it is the *worse* of the two in dark,
 * because `--muted` (L 16%) sits between `--border` (L 10%) and
 * `--border-strong` (L 18%). Strengthening the border makes it fainter.
 * Whichever token is picked, one theme gets no edge at all.
 *
 * So there is no border to pick. The fill separates from the card on its own at
 * 1.180 light / 1.153 dark - the same in both - which is what the Quick
 * Reference slabs in the script panels have always relied on.
 */

import { useState, useMemo } from "react";
import { Terminal, AlertCircle, ChevronDown, ChevronRight } from "lucide-react";
import { Badge, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui";
import { EmptyState } from "@/components/shared";

export interface ConsoleOutputProps {
	logs: string[];
	errors: {
		pre?: string;
		post?: string;
	};
}

interface ParsedLog {
	source: "pre" | "test";
	message: string;
}

export default function ConsoleOutput({ logs, errors }: ConsoleOutputProps) {
	// Parse logs to separate by source
	// Backend prefixes pre-script logs with "[pre] "
	const parsedLogs = useMemo((): ParsedLog[] => {
		return logs.map((log) => {
			if (log.startsWith("[pre] ")) {
				return { source: "pre", message: log.substring(6) };
			}
			return { source: "test", message: log };
		});
	}, [logs]);

	const preLogs = parsedLogs.filter((l) => l.source === "pre");
	const testLogs = parsedLogs.filter((l) => l.source === "test");

	const [preLogsOpen, setPreLogsOpen] = useState(true);
	const [testLogsOpen, setTestLogsOpen] = useState(true);

	return (
		<div className="p-4 overflow-auto h-full space-y-4">
			{/* Script Errors */}
			{(errors.pre || errors.post) && (
				<div className="space-y-2">
					{errors.pre && (
						<div className="p-3 rounded-md bg-destructive/10 border border-destructive/20">
							<div className="flex items-start gap-2">
								<AlertCircle className="w-4 h-4 text-destructive-text mt-0.5 flex-shrink-0" />
								<div className="flex-1 min-w-0">
									<p className="text-sm font-semibold text-destructive-text">
										Pre-request Script Error
									</p>
									<pre className="text-sm text-status-error-text mt-1 font-mono whitespace-pre-wrap break-words overflow-x-auto">
										{errors.pre}
									</pre>
								</div>
							</div>
						</div>
					)}
					{errors.post && (
						<div className="p-3 rounded-md bg-destructive/10 border border-destructive/20">
							<div className="flex items-start gap-2">
								<AlertCircle className="w-4 h-4 text-destructive-text mt-0.5 flex-shrink-0" />
								<div className="flex-1 min-w-0">
									<p className="text-sm font-semibold text-destructive-text">
										Test Script Error
									</p>
									<pre className="text-sm text-status-error-text mt-1 font-mono whitespace-pre-wrap break-words overflow-x-auto">
										{errors.post}
									</pre>
								</div>
							</div>
						</div>
					)}
				</div>
			)}

			{/*
			 * Colours below are tokens, not raw palette. `text-blue-500` /
			 * `text-green-500` are theme-blind - one value on both a white card and
			 * a near-black one - and measured 3.76 and 2.22 in light mode against
			 * 4.5 for the headings and badge labels. The `-text` tokens are
			 * per-theme: 5.98/6.76 and 5.68/8.80.
			 *
			 * The Terminal icons lost their `/70` rather than carrying it over.
			 * Even on the corrected token, 70% alpha over `bg-muted` came to 2.87
			 * in light against the 3.0 icon floor; at full opacity it is 4.83.
			 * Fading the marker that says which script a log came from was working
			 * against the point anyway.
			 */}
			{/* Console Logs */}
			{logs.length === 0 ? (
				<EmptyState variant="inline" title="No console output" />
			) : (
				<div className="space-y-3">
					{/* Pre-request Script Logs */}
					{preLogs.length > 0 && (
						<Collapsible open={preLogsOpen} onOpenChange={setPreLogsOpen}>
							<CollapsibleTrigger className="flex items-center gap-2 w-full text-left group">
								<div className="flex items-center justify-center w-5 h-5 rounded-md bg-status-running/20 group-hover:bg-status-running/30 transition-colors">
									{preLogsOpen ? (
										<ChevronDown className="w-4 h-4 text-status-running-text" />
									) : (
										<ChevronRight className="w-4 h-4 text-status-running-text" />
									)}
								</div>
								<h3 className="text-sm font-medium text-status-running-text">
									Pre-request Script
								</h3>
								<Badge
									variant="outline"
									className="ml-auto text-xs border-status-running/30 text-status-running-text"
								>
									{preLogs.length} log{preLogs.length !== 1 ? "s" : ""}
								</Badge>
							</CollapsibleTrigger>
							<CollapsibleContent className="mt-2">
								<div className="bg-muted p-3 rounded-md font-mono text-sm space-y-1">
									{preLogs.map((log, i) => (
										<div key={i} className="flex items-start gap-2">
											<Terminal className="w-4 h-4 text-status-running-text mt-0.5 flex-shrink-0" />
											<pre className="text-foreground whitespace-pre-wrap break-words flex-1 min-w-0">
												{log.message}
											</pre>
										</div>
									))}
								</div>
							</CollapsibleContent>
						</Collapsible>
					)}

					{/* Test Script Logs */}
					{testLogs.length > 0 && (
						<Collapsible open={testLogsOpen} onOpenChange={setTestLogsOpen}>
							<CollapsibleTrigger className="flex items-center gap-2 w-full text-left group">
								<div className="flex items-center justify-center w-5 h-5 rounded-md bg-status-success/20 group-hover:bg-status-success/30 transition-colors">
									{testLogsOpen ? (
										<ChevronDown className="w-4 h-4 text-status-success-text" />
									) : (
										<ChevronRight className="w-4 h-4 text-status-success-text" />
									)}
								</div>
								<h3 className="text-sm font-medium text-status-success-text">
									Test Script
								</h3>
								<Badge
									variant="outline"
									className="ml-auto text-xs border-status-success/30 text-status-success-text"
								>
									{testLogs.length} log{testLogs.length !== 1 ? "s" : ""}
								</Badge>
							</CollapsibleTrigger>
							<CollapsibleContent className="mt-2">
								<div className="bg-muted p-3 rounded-md font-mono text-sm space-y-1">
									{testLogs.map((log, i) => (
										<div key={i} className="flex items-start gap-2">
											<Terminal className="w-4 h-4 text-status-success-text mt-0.5 flex-shrink-0" />
											<pre className="text-foreground whitespace-pre-wrap break-words flex-1 min-w-0">
												{log.message}
											</pre>
										</div>
									))}
								</div>
							</CollapsibleContent>
						</Collapsible>
					)}
				</div>
			)}
		</div>
	);
}
