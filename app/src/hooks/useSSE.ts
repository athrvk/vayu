// useSSE Hook - Stream real-time load test metrics

import { useEffect, useCallback } from "react";
import { sseClient } from "@/services";
import { useDashboardStore } from "@/stores";
import type { LoadTestMetrics } from "@/types";

interface UseSSEParams {
	runId: string | null;
	enabled: boolean;
}

export function useSSE({ runId, enabled }: UseSSEParams): void {
	const { addMetrics, setError, setStreaming, stopRun } = useDashboardStore();

	const handleMessage = useCallback(
		(metrics: LoadTestMetrics) => {
			addMetrics(metrics);
		},
		[addMetrics]
	);

	const handleError = useCallback(
		(error: Error) => {
			console.error("SSE error:", error);
			// Only set error state, don't stop streaming - let reconnect logic handle it
			setError(error.message);
		},
		[setError]
	);

	const handleClose = useCallback(() => {
		console.log("SSE connection closed");
		setStreaming(false);
		stopRun();
	}, [setStreaming, stopRun]);

	useEffect(() => {
		if (!enabled || !runId) {
			sseClient.disconnect();
			return;
		}

		setStreaming(true);
		setError(null);

		// Add a small delay before connecting to give backend time to set up the run
		const connectTimeout = setTimeout(() => {
			sseClient.connect(runId, handleMessage, handleError, handleClose);
		}, 500);

		return () => {
			clearTimeout(connectTimeout);
			sseClient.disconnect();
		};
	}, [runId, enabled, handleMessage, handleError, handleClose, setStreaming, setError]);
}
