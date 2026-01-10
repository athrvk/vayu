import { useEffect } from "react";
import { useDashboardStore } from "@/stores";
import { useRuns } from "@/hooks";
import LoadTestDashboard from "../dashboard/LoadTestDashboard";

export default function HistoryDetail() {
	const { currentRunId, setFinalReport } = useDashboardStore();
	const { loadRunReport } = useRuns();

	useEffect(() => {
		if (currentRunId) {
			// Load the report for the selected run
			loadRunReport(currentRunId).then((report) => {
				if (report) {
					setFinalReport(report);
				}
			});
		}
	}, [currentRunId, loadRunReport, setFinalReport]);

	// Reuse the LoadTestDashboard component in "completed" mode
	return <LoadTestDashboard />;
}
