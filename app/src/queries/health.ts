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
 * What a failed poll means, given the start it failed on.
 *
 * A refused connection is the same transport error either way, so the failure
 * itself cannot tell an engine coming up from one that is not coming - only
 * whether a start is in flight can. `windowOpenedAt` is `null` when none is, and
 * an engine that answered with nothing starting is unreachable immediately, with
 * no grace: it proved it could serve, so its silence is news.
 *
 * Judged against the window rather than against the session's own age, because
 * the app itself restarts the engine (`useEngineRestart`) and the process that
 * comes back does the same cold-start work as the first one. Reading the session
 * instead called every restart a failure, since an engine had answered - the one
 * this one replaced (#1227).
 *
 * Derived here rather than pushed from the main process. `sidecar.ts` knows more
 * precisely - it holds the child handle and raises `EngineNotReadyError` on the
 * same budget - but `preload.ts` exposes no engine-status channel, and adding
 * one to say something the renderer's own poll already knows would be a second
 * source of truth for one label.
 */
export function engineStatusAfterFailedPoll(
	windowOpenedAt: number | null,
	now: number
): "starting" | "unreachable" {
	if (windowOpenedAt === null) return "unreachable";
	return now - windowOpenedAt < TIMING.ENGINE_STARTUP_GRACE_MS ? "starting" : "unreachable";
}

/**
 * Engine health check with automatic polling
 * Updates engine store with connection status
 */
export function useHealthQuery() {
	const {
		setEngineStatus,
		setEngineError,
		setEngineRecovery,
		openEngineStartWindow,
		closeEngineStartWindow,
	} = useEngineStore();
	const queryClient = useQueryClient();

	/**
	 * The launch's own start window, opened where the wait actually begins.
	 *
	 * Mount is the right moment: the hook is mounted once by `App`, at first
	 * paint, which is when the main process spawned the engine and started
	 * spending its own budget on the same wait. Opened in an effect rather than
	 * in render, because a clock read during render is impure
	 * (`react-hooks/purity`) - and nothing can have polled before this runs,
	 * provided this effect stays declared ahead of the sync effect below. In the
	 * other order a launch's first failure would find no window open at all and
	 * report the failure this exists to hide - which is what "records no
	 * reason…" in `health.test.ts` catches.
	 *
	 * The window lives in the engine store rather than in a ref here, because the
	 * restart path opens one too (#1227); see `engine-store.ts`.
	 */
	useEffect(() => {
		openEngineStartWindow(Date.now());
	}, [openEngineStartWindow]);

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
			// Whatever start this poll was waiting on is over; from here a silence
			// is an engine that stopped rather than one that has not arrived.
			closeEngineStartWindow();
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
			// Read, not subscribed. A window opened while the query's last state is
			// still a success - which is exactly what a restart does - would re-run
			// this effect into the branch above and close the window it had just
			// opened. So the window is consulted when a poll settles, and the poll
			// after it is what re-reads a window that closed meanwhile; a failing
			// poll is already on the fast cadence.
			const status = engineStatusAfterFailedPoll(
				useEngineStore.getState().engineStartWindow,
				Date.now()
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
		closeEngineStartWindow,
		queryClient,
	]);

	return query;
}
