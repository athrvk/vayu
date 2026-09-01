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
 * What a failed poll means, given the launch it failed on.
 *
 * A refused connection is the same transport error either way, so the failure
 * itself cannot tell a cold start from a dead engine - only its place in the
 * session can. An engine that answered once and stopped is unreachable
 * immediately, with no grace: it proved it could serve, so its silence is news.
 *
 * Derived here rather than pushed from the main process. `sidecar.ts` knows more
 * precisely - it holds the child handle and raises `EngineNotReadyError` on the
 * same budget - but `preload.ts` exposes no engine-status channel, and adding
 * one to say something the renderer's own poll already knows would be a second
 * source of truth for one label.
 */
export function engineStatusAfterFailedPoll(
	hasEverConnected: boolean,
	msSinceMount: number
): "starting" | "unreachable" {
	if (hasEverConnected) return "unreachable";
	return msSinceMount < TIMING.ENGINE_STARTUP_GRACE_MS ? "starting" : "unreachable";
}

/**
 * Engine health check with automatic polling
 * Updates engine store with connection status
 */
export function useHealthQuery() {
	const { setEngineStatus, setEngineError, setEngineRecovery } = useEngineStore();
	const queryClient = useQueryClient();

	/**
	 * When this session started counting, and whether the engine has ever
	 * answered it - the two facts that separate a cold start from a dead engine.
	 *
	 * Mount is the right zero: the hook is mounted once by `App`, at first paint,
	 * which is when the main process spawned the engine and started spending its
	 * own budget on the same wait. Stamped in an effect rather than in the render
	 * that declares the ref, because a clock read during render is impure
	 * (`react-hooks/purity`) - and nothing can have polled before this runs,
	 * provided this effect stays declared ahead of the sync effect below. In the
	 * other order a launch's first failure would measure against zero, land far
	 * past the grace window, and report the failure this issue exists to hide -
	 * which is what "records no reason…" in `health.test.ts` catches.
	 */
	const mountedAt = useRef(0);
	const hasEverConnected = useRef(false);

	useEffect(() => {
		mountedAt.current = Date.now();
	}, []);

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
			hasEverConnected.current = true;
			setEngineStatus("connected");
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
			const status = engineStatusAfterFailedPoll(
				hasEverConnected.current,
				Date.now() - mountedAt.current
			);
			setEngineStatus(status);
			// A launch still inside the grace window has nothing to report yet, and
			// the poll that ends the window carries the reason with it.
			if (status === "starting") {
				setEngineError(null);
				return;
			}
			const errorMessage =
				query.error instanceof Error ? query.error.message : "Cannot connect to engine";
			setEngineError(errorMessage);
		}
	}, [
		query.isSuccess,
		query.isError,
		query.data,
		query.error,
		setEngineStatus,
		setEngineError,
		setEngineRecovery,
		queryClient,
	]);

	return query;
}
