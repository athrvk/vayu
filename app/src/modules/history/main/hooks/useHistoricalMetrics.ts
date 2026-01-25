
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useHistoricalMetrics Hook
 *
 * Fetches historical metrics from the /stats/:runId endpoint for completed runs.
 * This allows displaying charts for historical load test runs.
 */

import { useState, useEffect, useCallback } from "react";
import { API_ENDPOINTS } from "@/config/api-endpoints";

export interface HistoricalMetric {
	timestamp: number;
	elapsedSeconds: number;
	totalRequests: number;
	totalErrors: number;
	currentRps: number;
	avgLatencyMs: number;
	activeConnections: number;
	sendRate: number;
	throughput: number;
	backpressure: number;
}

interface UseHistoricalMetricsResult {
	metrics: HistoricalMetric[];
	isLoading: boolean;
	error: string | null;
}

export function useHistoricalMetrics(runId: string | null): UseHistoricalMetricsResult {
	const [metrics, setMetrics] = useState<HistoricalMetric[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const fetchMetrics = useCallback(async () => {
		if (!runId) return;

		setIsLoading(true);
		setError(null);
		setMetrics([]);

		const url = `${API_ENDPOINTS.BASE_URL}${API_ENDPOINTS.STATS_STREAM(runId)}`;

		try {
			const eventSource = new EventSource(url);
			const collectedMetrics: HistoricalMetric[] = [];

			eventSource.addEventListener("metrics", (event) => {
				try {
					const data = JSON.parse(event.data);
					collectedMetrics.push({
						timestamp: data.timestamp || Date.now(),
						elapsedSeconds: data.elapsedSeconds || 0,
						totalRequests: data.totalRequests || 0,
						totalErrors: data.totalErrors || 0,
						currentRps: data.currentRps || 0,
						avgLatencyMs: data.avgLatencyMs || 0,
						activeConnections: data.activeConnections || 0,
						sendRate: data.sendRate || 0,
						throughput: data.throughput || 0,
						backpressure: data.backpressure || 0,
					});
					// Update state periodically to show progress
					if (collectedMetrics.length % 10 === 0) {
						setMetrics([...collectedMetrics]);
					}
				} catch (err) {
					console.error("Failed to parse metrics:", err);
				}
			});

			eventSource.addEventListener("complete", () => {
				setMetrics([...collectedMetrics]);
				setIsLoading(false);
				eventSource.close();
			});

			eventSource.addEventListener("error", () => {
				// Check if we got any data before the error
				if (collectedMetrics.length > 0) {
					setMetrics([...collectedMetrics]);
				}
				setIsLoading(false);
				eventSource.close();
			});

			// Timeout after 30 seconds in case the stream doesn't close
			const timeout = setTimeout(() => {
				if (collectedMetrics.length > 0) {
					setMetrics([...collectedMetrics]);
				}
				setIsLoading(false);
				eventSource.close();
			}, 30000);

			return () => {
				clearTimeout(timeout);
				eventSource.close();
			};
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to fetch metrics");
			setIsLoading(false);
		}
	}, [runId]);

	useEffect(() => {
		fetchMetrics();
	}, [fetchMetrics]);

	return { metrics, isLoading, error };
}
