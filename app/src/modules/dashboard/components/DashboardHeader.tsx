
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * DashboardHeader Component
 *
 * Compact 52px single-row header with status, method, URL, config info, and stop button
 */

import { useEffect, useState } from "react";
import { StopCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import { getMethodColor } from "@/utils";
import type { DashboardHeaderProps } from "../types";

function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export default function DashboardHeader({
	mode,
	isStreaming,
	isStopping,
	onStop,
	requestUrl,
	requestMethod,
	elapsedDuration = 0,
	configuration,
}: DashboardHeaderProps) {
	// Live counter for running tests — reset to 0 each time a new run starts
	const [liveTick, setLiveTick] = useState(0);

	useEffect(() => {
		if (mode === "running" && isStreaming) {
			setLiveTick(0);
			const interval = setInterval(() => setLiveTick((t) => t + 1), 1000);
			return () => clearInterval(interval);
		}
	}, [mode, isStreaming]);

	const displayMs =
		mode === "running" && isStreaming
			? elapsedDuration + liveTick * 1000
			: elapsedDuration;

	// Config summary line
	const configParts: string[] = [];
	if (configuration?.concurrency != null) configParts.push(`${configuration.concurrency} VUs`);
	if (configuration?.mode) {
		const modeLabel =
			configuration.mode === "rps" ? "RPS Mode" :
			configuration.mode === "concurrency" ? "Concurrency Mode" :
			configuration.mode;
		configParts.push(modeLabel);
	}
	if (displayMs > 0) configParts.push(`${formatElapsed(displayMs)} elapsed`);
	const configSummary = configParts.join(" · ");

	return (
		<div className="h-[52px] flex items-center gap-3 px-5 bg-panel border-b border-border shrink-0">
			{/* Status pill */}
			{isStreaming ? (
				<span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold tracking-wide bg-green-500/15 text-green-500 border border-green-500/25 shrink-0">
					<span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
					LIVE
				</span>
			) : mode === "completed" ? (
				<span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold tracking-wide bg-muted text-muted-foreground border border-border shrink-0">
					COMPLETED
				</span>
			) : mode === "stopped" ? (
				<span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold tracking-wide bg-muted text-muted-foreground border border-border shrink-0">
					STOPPED
				</span>
			) : null}

			{/* Method badge */}
			{requestMethod && (
				<span
					className="text-[11px] font-bold font-mono px-1.5 py-0.5 rounded shrink-0"
					style={{
						color: getMethodColor(requestMethod),
						background: `${getMethodColor(requestMethod)}18`,
						border: `1px solid ${getMethodColor(requestMethod)}30`,
					}}
				>
					{requestMethod.toUpperCase()}
				</span>
			)}

			{/* URL */}
			{requestUrl ? (
				<span className="text-[12px] font-mono text-foreground flex-1 truncate min-w-0">
					{requestUrl}
				</span>
			) : (
				<span className="flex-1" />
			)}

			{/* Config summary */}
			{configSummary && (
				<span className="text-[12px] text-muted-foreground shrink-0 hidden sm:block">
					{configSummary}
				</span>
			)}

			{/* Stop button */}
			{mode === "running" && (
				<Button
					size="sm"
					variant="ghost"
					onClick={onStop}
					disabled={isStopping}
					className="h-7 px-2.5 text-[12px] text-destructive hover:bg-destructive/10 hover:text-destructive border border-destructive/30 shrink-0"
				>
					{isStopping ? (
						<>
							<Loader2 className="w-3 h-3 animate-spin mr-1.5" />
							Stopping…
						</>
					) : (
						<>
							<StopCircle className="w-3 h-3 mr-1.5" />
							Stop
						</>
					)}
				</Button>
			)}
		</div>
	);
}
