/**
 * DashboardHeader Component
 *
 * Header with title, status badge, back button, and stop button
 */

import { Activity, StopCircle, Loader2, ArrowLeft } from "lucide-react";
import { Button, Badge } from "@/components/ui";
import { useNavigationStore } from "@/stores";
import type { DashboardHeaderProps } from "../types";

export default function DashboardHeader({
	mode,
	isStreaming,
	isStopping,
	onStop,
}: DashboardHeaderProps) {
	const { navigateBack, canNavigateBack } = useNavigationStore();
	const showBackButton = canNavigateBack();

	return (
		<div className="flex items-center justify-between">
			<div className="flex items-center gap-3">
				{showBackButton && (
					<Button
						variant="ghost"
						size="icon"
						onClick={navigateBack}
						className="h-8 w-8"
						title="Back to Request Builder"
					>
						<ArrowLeft className="w-4 h-4" />
					</Button>
				)}
				<Activity className="w-6 h-6 text-primary" />
				<h2 className="text-xl font-semibold text-foreground">Load Test Dashboard</h2>
				{isStreaming && (
					<Badge
						variant="outline"
						className="bg-success/10 text-success border-success/20"
					>
						<span className="w-2 h-2 bg-success rounded-full animate-pulse mr-2" />
						Live
					</Badge>
				)}
				{mode === "completed" && <Badge variant="secondary">Completed</Badge>}
				{mode === "stopped" && (
					<Badge variant="outline" className="border-warning text-warning">
						Stopped
					</Badge>
				)}
			</div>

			<div className="flex items-center gap-2">
				{mode === "running" && (
					<Button variant="destructive" onClick={onStop} disabled={isStopping}>
						{isStopping ? (
							<>
								<Loader2 className="w-4 h-4 animate-spin mr-2" />
								Stopping...
							</>
						) : (
							<>
								<StopCircle className="w-4 h-4 mr-2" />
								Stop Test
							</>
						)}
					</Button>
				)}
			</div>
		</div>
	);
}
