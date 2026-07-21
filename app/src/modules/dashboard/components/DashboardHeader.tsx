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

import { ArrowLeft, StopCircle, Loader2 } from "lucide-react";
import { Button, TooltipIconButton } from "@/components/ui";
import { useTabsStore, useDashboardStore } from "@/stores";
import type { DashboardHeaderProps } from "../types";
import { MethodBadge } from "@/components/shared";

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
	const { openTabs, activeTabId, openTab, closeTab } = useTabsStore();
	const sourceRequestId = useDashboardStore((s) => s.sourceRequestId);

	const canNavigateBack = sourceRequestId != null || openTabs.length > 1;
	const navigateBack = () => {
		// Prefer returning to the request that started this run; otherwise fall
		// back to closing the dashboard tab.
		if (sourceRequestId) {
			openTab({ type: "request", entityId: sourceRequestId });
		} else if (activeTabId) {
			closeTab(activeTabId);
		}
	};

	// Elapsed time is driven entirely by `elapsedDuration`, which is the engine's
	// authoritative elapsed while running (last SSE tick's elapsed_seconds) and
	// the final report's testDuration once completed. Both are monotonic, so the
	// timer never double-counts or jumps backward. (A previous client-side 1s
	// liveTick was ADDED on top of elapsedDuration — since both advanced on
	// different clocks, the timer ran ~2x fast and flickered/regressed on desync.)
	const displayMs = elapsedDuration;

	// Config summary line
	const configParts: string[] = [];
	if (configuration?.concurrency != null) configParts.push(`${configuration.concurrency} VUs`);
	if (configuration?.mode) {
		const modeLabel =
			configuration.mode === "rps"
				? "RPS Mode"
				: configuration.mode === "concurrency"
					? "Concurrency Mode"
					: configuration.mode;
		configParts.push(modeLabel);
	}
	if (displayMs > 0) configParts.push(`${formatElapsed(displayMs)} elapsed`);
	const configSummary = configParts.join(" · ");

	return (
		<div className="h-[52px] flex items-center gap-3 px-5 bg-panel border-b border-border shrink-0">
			{/* Back button — returns to the previous screen (typically request builder) */}
			{canNavigateBack && (
				<TooltipIconButton
					label="Back"
					icon={<ArrowLeft className="w-4 h-4" />}
					onClick={navigateBack}
					className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
				/>
			)}

			{/* Status pill */}
			{isStreaming ? (
				<span className="flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold tracking-wide bg-status-success/15 text-status-success-text border border-status-success/25 shrink-0">
					<span className="w-1.5 h-1.5 rounded-full bg-status-success animate-pulse" />
					LIVE
				</span>
			) : mode === "completed" ? (
				<span className="flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold tracking-wide bg-muted text-muted-foreground border border-border shrink-0">
					COMPLETED
				</span>
			) : mode === "stopped" ? (
				<span className="flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold tracking-wide bg-muted text-muted-foreground border border-border shrink-0">
					STOPPED
				</span>
			) : null}

			{/* Method badge */}
			{requestMethod && <MethodBadge method={requestMethod} size="md" />}

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
					className="h-7 px-2.5 text-[12px] text-destructive-text hover:bg-destructive/10 hover:text-destructive-text border border-destructive/30 shrink-0"
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
