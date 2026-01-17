
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Health Query
 *
 * TanStack Query hook for engine health check with automatic polling.
 */

import { useQuery } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { queryKeys } from "./keys";
import { useEngineConnectionStore } from "@/stores";
import { useEffect } from "react";

const HEALTH_CHECK_INTERVAL_MS = 10000; // 10 seconds

/**
 * Engine health check with automatic polling
 * Updates engine connection store with connection status
 */
export function useHealthQuery() {
	const { setEngineConnected, setEngineError } = useEngineConnectionStore();

	const query = useQuery({
		queryKey: queryKeys.health.status(),
		queryFn: () => apiService.getHealth(),
		refetchInterval: HEALTH_CHECK_INTERVAL_MS,
		retry: 1,
		// Don't show stale data for health checks
		staleTime: 0,
	});

	// Sync query state with app store
	useEffect(() => {
		if (query.isSuccess && query.data?.status === "ok") {
			setEngineConnected(true);
			setEngineError(null);
		} else if (query.isError) {
			setEngineConnected(false);
			const errorMessage =
				query.error instanceof Error ? query.error.message : "Cannot connect to engine";
			setEngineError(errorMessage);
		}
	}, [
		query.isSuccess,
		query.isError,
		query.data,
		query.error,
		setEngineConnected,
		setEngineError,
	]);

	return query;
}
