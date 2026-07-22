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
			{/*
			    `border-input`, not `border-border`. This is a text field, and
			    `--input` was raised on this branch precisely so a field has an edge
			    - but the URL bar spells its own border rather than inheriting the
			    `Input` primitive, so that fix passed it by. Measured in the running
			    app: `--border` on `--card` is **1.003**, meaning the most-used
			    control in Vayu had no visible boundary in dark mode beyond the
			    card-on-panel step, which is itself only 1.09.
			 */}
			<UrlInput className="flex-1 h-[34px] bg-card border border-input rounded-md px-3 text-sm font-mono focus-within:border-primary focus-within:ring-0 transition-colors shadow-none" />
			{/* Send button with loading state */}
			<button
				onClick={executeRequest}
				disabled={!canExecute}
				className="h-[34px] px-4 rounded-md bg-primary-fill text-white text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50 transition-opacity shrink-0 font-[inherit]"
			>
				{isExecuting ? (
					<>
						<span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-[vayu-spin_0.7s_linear_infinite] inline-block" />
						Sending
					</>
				) : (
					<>
						{/*
						 * The triangle is decoration, but it is a text node, so it
						 * lands in the button's accessible name - screen readers
						 * announce U+25B6 by its Unicode name before the word
						 * "Send". Hidden rather than removed: it is doing visual
						 * work in a bar of otherwise identical-looking buttons.
						 */}
						<span aria-hidden="true">▶</span> Send
					</>
				)}
			</button>
			{/* Load Test button - while a run is live it becomes a shortcut to the
			    running dashboard (single-active-run policy).

			    The running variant was `text-green-500` on `bg-green-500/10`: a
			    12px semibold label separated from its background only by alpha,
			    measuring 1.95 in light mode against a 4.5 requirement. Raw palette
			    meant it was one value on both themes, so the light failure could
			    not be fixed without breaking dark (which was fine at 7.40). It now
			    mirrors the idle variant's `text-primary border-primary bg-primary/10`
			    shape with status tokens, and measures 4.98 light / 8.36 dark. */}
			{isLoadTestRunning ? (
				<button
					onClick={viewRunningTest}
					className="h-[34px] px-3.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-opacity shrink-0 font-[inherit] text-status-success-text border border-status-success/40 bg-status-success/10"
				>
					<Activity className="w-3.5 h-3.5" />
					View running test
				</button>
			) : (
				<button
					onClick={startLoadTest}
					disabled={!canExecute}
					className="h-[34px] px-3.5 rounded-md text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 transition-opacity shrink-0 font-[inherit] text-primary border border-primary bg-primary/10"
				>
					<Zap className="w-3.5 h-3.5" />
					Load Test
				</button>
			)}
		</div>
	);
}
