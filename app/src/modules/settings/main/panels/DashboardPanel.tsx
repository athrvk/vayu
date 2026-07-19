/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * DashboardPanel
 *
 * Behavioral preferences for live test dashboards and charts. Today: the live
 * chart retention window. This is the home for chart/dashboard knobs so they
 * stop leaking into Appearance — granularity, default SLO line, and units can
 * land here as they arrive. Client-side only (localStorage-backed).
 */

import { History, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { useLiveChartWindow } from "@/hooks/useLiveChartWindow";
import { LIVE_WINDOW_OPTIONS } from "@/constants/live-window";
import { cn } from "@/lib/utils";

export default function DashboardPanel() {
	const { window: liveWindow, setWindow: setLiveWindow } = useLiveChartWindow();

	return (
		<Card>
			<CardHeader className="pb-3">
				<div className="flex items-center gap-2">
					<History className="w-5 h-5 text-muted-foreground" />
					<CardTitle className="text-base">Live Dashboard</CardTitle>
				</div>
				<CardDescription>
					How much recent history the live charts keep. Older data rolls off; completed
					runs in History always show the full run.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
					Chart window
				</p>
				<div className="grid grid-cols-5 gap-3">
					{LIVE_WINDOW_OPTIONS.map((option) => {
						const isSelected = liveWindow === option.value;
						return (
							<button
								key={option.value}
								onClick={() => setLiveWindow(option.value)}
								className={cn(
									"relative flex items-center justify-center p-3 rounded-lg border-2 text-center transition-all",
									"hover:bg-accent hover:border-accent-foreground/20",
									isSelected ? "border-primary bg-primary/5" : "border-border"
								)}
							>
								<span
									className={cn(
										"text-sm font-medium",
										isSelected && "text-primary"
									)}
								>
									{option.label}
								</span>
								{isSelected && (
									<CheckCircle2 className="w-4 h-4 text-primary absolute top-1.5 right-1.5" />
								)}
							</button>
						);
					})}
				</div>
			</CardContent>
		</Card>
	);
}
