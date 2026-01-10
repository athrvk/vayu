// useHealthCheck Hook - Monitor engine connection

import { useEffect, useCallback } from "react";
import { apiService } from "@/services";
import { useAppStore } from "@/stores";

const HEALTH_CHECK_INTERVAL_MS = 10000; // Check every 10 seconds

export function useHealthCheck(): void {
	const { setEngineConnected, setEngineError } = useAppStore();

	const checkHealth = useCallback(async () => {
		try {
			const health = await apiService.getHealth();
			if (health.status === "ok") {
				setEngineConnected(true);
				setEngineError(null);
			} else {
				setEngineConnected(false);
				setEngineError("Engine is down");
			}
		} catch (error) {
			setEngineConnected(false);
			const errorMessage =
				error instanceof Error ? error.message : "Cannot connect to engine";
			setEngineError(errorMessage);
		}
	}, [setEngineConnected, setEngineError]);

	useEffect(() => {
		// Initial check
		checkHealth();

		// Periodic checks
		const interval = setInterval(checkHealth, HEALTH_CHECK_INTERVAL_MS);

		return () => {
			clearInterval(interval);
		};
	}, [checkHealth]);
}
