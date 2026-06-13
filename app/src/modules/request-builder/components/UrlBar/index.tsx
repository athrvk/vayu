/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * UrlBar Component
 *
 * The main URL input bar containing:
 * - HTTP method selector
 * - URL input with variable support
 * - Action buttons (Send, Load Test)
 */

import { Zap, Activity } from "lucide-react";
import { useRequestBuilderContext } from "../../context";
import { useDashboardStore, useTabsStore } from "@/stores";
import MethodSelector from "./MethodSelector";
import UrlInput from "./UrlInput";

export default function UrlBar() {
	const { request, isExecuting, executeRequest, startLoadTest } = useRequestBuilderContext();
	const isLoadTestRunning = useDashboardStore((s) => s.isStreaming);
	const openTab = useTabsStore((s) => s.openTab);

	const canExecute = !isExecuting && request.url.trim().length > 0;
	const viewRunningTest = () => openTab({ type: "dashboard", entityId: null });

	return (
		<div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-panel shrink-0">
			<MethodSelector />
			<UrlInput className="flex-1 h-[34px] bg-card border border-border rounded-md px-3 text-[13px] font-mono focus-within:border-primary focus-within:ring-0 transition-colors shadow-none" />
			{/* Send button with loading state */}
			<button
				onClick={executeRequest}
				disabled={!canExecute}
				className="h-[34px] px-4 rounded-md bg-primary text-white text-[13px] font-semibold flex items-center gap-1.5 disabled:opacity-50 transition-opacity shrink-0 font-[inherit]"
			>
				{isExecuting ? (
					<>
						<span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-[vayu-spin_0.7s_linear_infinite] inline-block" />
						Sending
					</>
				) : (
					<>▶ Send</>
				)}
			</button>
			{/* Load Test button — while a run is live it becomes a shortcut to the
			    running dashboard (single-active-run policy). */}
			{isLoadTestRunning ? (
				<button
					onClick={viewRunningTest}
					className="h-[34px] px-3.5 rounded-md text-[12px] font-semibold flex items-center gap-1.5 transition-opacity shrink-0 font-[inherit] text-green-500 border border-green-500/40 bg-green-500/10"
				>
					<Activity className="w-3.5 h-3.5" />
					View running test
				</button>
			) : (
				<button
					onClick={startLoadTest}
					disabled={!canExecute}
					className="h-[34px] px-3.5 rounded-md text-[12px] font-semibold flex items-center gap-1.5 disabled:opacity-50 transition-opacity shrink-0 font-[inherit] text-primary border border-primary bg-primary/10"
				>
					<Zap className="w-3.5 h-3.5" />
					Load Test
				</button>
			)}
		</div>
	);
}
