/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * LoadRunInProgress
 *
 * What a load run's History tab shows while the engine is still executing it.
 *
 * The report endpoint answers for a live run, but it describes a run that has
 * not finished: percentiles over the requests so far, no final error rate. A
 * pane that rendered it read as a result and then stayed that way, because the
 * tab had no way to learn the run ended (#1934). So the tab shows no numbers
 * until the run is over, says so, and keeps the two things that are useful in
 * the meantime: Stop, and the live dashboard when this window is the one
 * watching the run.
 */

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import { EmptyState, StopRunButton } from "@/components/shared";
import { useStopRun } from "@/hooks/useStopRun";
import { useDashboardStore, useTabsStore } from "@/stores";

interface LoadRunInProgressProps {
	runId: string;
}

export default function LoadRunInProgress({ runId }: LoadRunInProgressProps) {
	const openTab = useTabsStore((s) => s.openTab);
	const { stop, isStopping } = useStopRun(runId);
	// The dashboard shows whichever run this window is streaming. A run started
	// elsewhere (another window, a relaunch) is not on it, and a button that
	// opened an empty dashboard would promise a view that is not there.
	const dashboardShowsThisRun = useDashboardStore((s) => s.currentRunId === runId);

	return (
		<div className="flex h-full flex-col">
			<EmptyState
				icon={Loader2}
				iconClassName="animate-spin"
				title="This load test is still running"
				description="Its results appear here when it finishes."
				action={
					<div className="flex items-center gap-2">
						<StopRunButton onStop={() => void stop()} isStopping={isStopping} />
						{dashboardShowsThisRun && (
							<Button
								variant="outline"
								size="sm"
								onClick={() => openTab({ type: "dashboard", entityId: null })}
							>
								Open dashboard
							</Button>
						)}
					</div>
				}
			/>
		</div>
	);
}
