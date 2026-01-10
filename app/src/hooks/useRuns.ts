// useRuns Hook - Load and manage run history

import { useState, useCallback } from "react";
import { apiService } from "@/services";
import { useHistoryStore } from "@/stores";
import type { Run, RunReport } from "@/types";

interface UseRunsReturn {
	runs: Run[];
	loadRuns: () => Promise<void>;
	loadRunReport: (runId: string) => Promise<RunReport | null>;
	deleteRun: (runId: string) => Promise<boolean>;
	isLoading: boolean;
	error: string | null;
}

export function useRuns(): UseRunsReturn {
	const {
		runs,
		setRuns,
		removeRun,
		setLoading: setStoreLoading,
		setError: setStoreError,
		setTotalCount,
		setDeletingRun,
	} = useHistoryStore();

	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const loadRuns = useCallback(
		async () => {
			setIsLoading(true);
			setStoreLoading(true);
			setError(null);
			setStoreError(null);

			try {
				// Backend returns flat array directly
				const loadedRuns = await apiService.listRuns();
				setRuns(loadedRuns);
				setTotalCount(loadedRuns.length);
			} catch (err) {
				const errorMessage =
					err instanceof Error ? err.message : "Failed to load runs";
				setError(errorMessage);
				setStoreError(errorMessage);
			} finally {
				setIsLoading(false);
				setStoreLoading(false);
			}
		},
		[setRuns, setStoreLoading, setStoreError, setTotalCount]
	);

	const loadRunReport = useCallback(
		async (runId: string): Promise<RunReport | null> => {
			setError(null);
			try {
				const report = await apiService.getRunReport(runId);
				return report;
			} catch (err) {
				const errorMessage =
					err instanceof Error ? err.message : "Failed to load run report";
				setError(errorMessage);
				return null;
			}
		},
		[]
	);

	const deleteRun = useCallback(
		async (runId: string): Promise<boolean> => {
			setError(null);
			setDeletingRun(true);
			try {
				await apiService.deleteRun(runId);
				removeRun(runId);
				return true;
			} catch (err) {
				const errorMessage =
					err instanceof Error ? err.message : "Failed to delete run";
				setError(errorMessage);
				return false;
			} finally {
				setDeletingRun(false);
			}
		},
		[removeRun, setDeletingRun]
	);

	return {
		runs,
		loadRuns,
		loadRunReport,
		deleteRun,
		isLoading,
		error,
	};
}
