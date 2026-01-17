/**
 * ConsoleOutput Component
 *
 * Displays console logs separated by pre-scripts and tests.
 */

import { useState, useMemo } from "react";
import { Terminal, AlertCircle, ChevronDown, ChevronRight } from "lucide-react";
import { Badge, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui";

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
						<div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
							<div className="flex items-start gap-2">
								<AlertCircle className="w-4 h-4 text-destructive mt-0.5 flex-shrink-0" />
								<div className="flex-1 min-w-0">
									<p className="text-sm font-semibold text-destructive">
										Pre-request Script Error
									</p>
									<pre className="text-sm text-red-400 mt-1 font-mono whitespace-pre-wrap break-words overflow-x-auto">
										{errors.pre}
									</pre>
								</div>
							</div>
						</div>
					)}
					{errors.post && (
						<div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
							<div className="flex items-start gap-2">
								<AlertCircle className="w-4 h-4 text-destructive mt-0.5 flex-shrink-0" />
								<div className="flex-1 min-w-0">
									<p className="text-sm font-semibold text-destructive">
										Test Script Error
									</p>
									<pre className="text-sm text-red-400 mt-1 font-mono whitespace-pre-wrap break-words overflow-x-auto">
										{errors.post}
									</pre>
								</div>
							</div>
						</div>
					)}
				</div>
			)}

			{/* Console Logs */}
			{logs.length === 0 ? (
				<div className="p-8 text-center text-muted-foreground">No console output</div>
			) : (
				<div className="space-y-3">
					{/* Pre-request Script Logs */}
					{preLogs.length > 0 && (
						<Collapsible open={preLogsOpen} onOpenChange={setPreLogsOpen}>
							<CollapsibleTrigger className="flex items-center gap-2 w-full text-left group">
								<div className="flex items-center justify-center w-5 h-5 rounded bg-blue-500/20 group-hover:bg-blue-500/30 transition-colors">
									{preLogsOpen ? (
										<ChevronDown className="w-4 h-4 text-blue-500" />
									) : (
										<ChevronRight className="w-4 h-4 text-blue-500" />
									)}
								</div>
								<h3 className="text-sm font-medium text-blue-500">
									Pre-request Script
								</h3>
								<Badge
									variant="outline"
									className="ml-auto text-xs border-blue-500/30 text-blue-500"
								>
									{preLogs.length} log{preLogs.length !== 1 ? "s" : ""}
								</Badge>
							</CollapsibleTrigger>
							<CollapsibleContent className="mt-2">
								<div className="bg-zinc-900 rounded-md p-3 font-mono text-sm space-y-1 border border-zinc-800">
									{preLogs.map((log, i) => (
										<div key={i} className="flex items-start gap-2">
											<Terminal className="w-4 h-4 text-blue-500/70 mt-0.5 flex-shrink-0" />
											<pre className="text-zinc-300 whitespace-pre-wrap break-words flex-1 min-w-0">
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
								<div className="flex items-center justify-center w-5 h-5 rounded bg-green-500/20 group-hover:bg-green-500/30 transition-colors">
									{testLogsOpen ? (
										<ChevronDown className="w-4 h-4 text-green-500" />
									) : (
										<ChevronRight className="w-4 h-4 text-green-500" />
									)}
								</div>
								<h3 className="text-sm font-medium text-green-500">Test Script</h3>
								<Badge
									variant="outline"
									className="ml-auto text-xs border-green-500/30 text-green-500"
								>
									{testLogs.length} log{testLogs.length !== 1 ? "s" : ""}
								</Badge>
							</CollapsibleTrigger>
							<CollapsibleContent className="mt-2">
								<div className="bg-zinc-900 rounded-md p-3 font-mono text-sm space-y-1 border border-zinc-800">
									{testLogs.map((log, i) => (
										<div key={i} className="flex items-start gap-2">
											<Terminal className="w-4 h-4 text-green-500/70 mt-0.5 flex-shrink-0" />
											<pre className="text-zinc-300 whitespace-pre-wrap break-words flex-1 min-w-0">
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
