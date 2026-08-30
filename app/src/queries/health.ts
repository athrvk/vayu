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

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { queryKeys } from "./keys";
import { useEngineStore } from "@/stores";
import { useEffect, useRef } from "react";
import { TIMING } from "@/config/timing";

/**
 * How hard to poll `/health`, given how the last poll went.
 *
 * Two speeds, because the disconnected state is no longer only an engine that
 * crashed: the window now loads while the engine is still starting, so the
 * first seconds of an ordinary launch are spent here and the poll that ends
 * them is on the startup path. Extracted so both branches are assertable
 * without driving a timer.
 */
export function healthPollIntervalMs(status: "error" | "pending" | "success"): number {
	return status === "error"
		? TIMING.HEALTH_RECONNECT_POLL_INTERVAL_MS
		: TIMING.HEALTH_CHECK_INTERVAL_MS;
}

/**
 * Engine health check with automatic polling
 * Updates engine store with connection status
 */
export function useHealthQuery() {
	const { setEngineConnected, setEngineError, setEngineRecovery } = useEngineStore();
	const queryClient = useQueryClient();

	/**
	 * Set by a poll that failed, cleared by the recovery it earns.
	 *
	 * An engine that answers is not by itself news - on an ordinary launch every
	 * query is already in flight and refetching them all would be a second boot's
	 * worth of requests for nothing. Only a health poll that actually failed
	 * means there are queries out there holding an error the engine has since
	 * stopped deserving.
	 */
	const sawDisconnect = useRef(false);

	const query = useQuery({
		queryKey: queryKeys.health.status(),
		queryFn: () => apiService.getHealth(),
		// Hard while it is not answering, cheap once it is.
		refetchInterval: (q) => healthPollIntervalMs(q.state.status),
		retry: 1,
		// Don't show stale data for health checks
		staleTime: 0,
	});

	// Sync query state with app store
	useEffect(() => {
		if (query.isSuccess && query.data?.status === "ok") {
			setEngineConnected(true);
			setEngineError(null);
			// Absent means a clean start, so it clears rather than being left
			// alone - the engine that answered this poll is the authority on
			// what its own startup did, including a different engine answering
			// on the port after a restart.
			setEngineRecovery(query.data.recovery ?? null);

			// Nothing else in the app notices an engine that arrives late. Every
			// other query gives up after `shouldRetryQuery`'s two attempts, and a
			// connection refused by a port nothing is listening on is a plain
			// `Error`, not an `ApiError` - so collections, runs and config settle
			// into an error state that no interval revisits. `refetchOnReconnect`
			// does not cover this: it fires on the browser's online/offline event,
			// which localhost never changes. Since the window now loads while the
			// engine is still starting, that state is reachable on an ordinary
			// launch rather than only on an engine crash. Same move the manual
			// restart makes (`useEngineRestart`), for the same reason.
			if (sawDisconnect.current) {
				sawDisconnect.current = false;
				void queryClient.invalidateQueries();
			}
		} else if (query.isError) {
			sawDisconnect.current = true;
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
		setEngineRecovery,
		queryClient,
	]);

	return query;
}
