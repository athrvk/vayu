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
import { useEngineStore, useSaveStore } from "@/stores";
import { systemNotify, NOTIFY_KINDS } from "@/services/notify";
import { useEffect, useRef } from "react";
import { TIMING } from "@/config/timing";
import { engineStarting, engineStatusAfterFailedPoll } from "@/lib/engine-start-window";

/**
 * How hard to poll `/health`, given how the last poll went.
 *
 * Two speeds, because the disconnected state is no longer only an engine that
 * crashed: the window now loads while the engine is still starting, so the
 * first seconds of an ordinary launch are spent here and the poll that ends
 * them is on the startup path. Extracted so both branches are assertable
 * without driving a timer.
 */
export function healthPollIntervalMs(
	status: "error" | "pending" | "success",
	starting: boolean
): number {
	if (status !== "error") return TIMING.HEALTH_CHECK_INTERVAL_MS;
	return starting
		? TIMING.HEALTH_STARTUP_POLL_INTERVAL_MS
		: TIMING.HEALTH_RECONNECT_POLL_INTERVAL_MS;
}

/**
 * Engine health check with automatic polling
 * Updates engine store with connection status
 */
export function useHealthQuery() {
	const setEngineStatus = useEngineStore((s) => s.setEngineStatus);
	const setEngineError = useEngineStore((s) => s.setEngineError);
	const setEngineRecovery = useEngineStore((s) => s.setEngineRecovery);
	const setWorkers = useEngineStore((s) => s.setWorkers);
	const openEngineStartWindow = useEngineStore((s) => s.openEngineStartWindow);
	const closeEngineStartWindow = useEngineStore((s) => s.closeEngineStartWindow);
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
		// Hard while it is not answering, hardest while it is still starting,
		// cheap once it is.
		refetchInterval: (q) => healthPollIntervalMs(q.state.status, engineStarting()),
		// One retry absorbs a single dropped poll of an engine that was serving.
		// None while a start is in flight: the retry waits TanStack's default
		// second before the failure surfaces, and the failure is what hands the
		// query to the startup poll and marks the queries that raced the engine
		// for the refetch below.
		retry: (failureCount) => !engineStarting() && failureCount < 1,
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
			setWorkers(query.data.workers);

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
				// The same gap one layer down: a dirty editor's own auto-save
				// retry backs off up to SAVE_RETRY_MAX_DELAY_MS, and an engine
				// that came back sooner than that should not wait for it. Every
				// dirty registered context is safe to flush here - unlike the
				// quit flush, nothing about a reconnect implies urgency for a
				// context that has never failed, and `flushAll` on one with
				// nothing pending is a no-op.
				void useSaveStore.getState().flushAll();
			}
		} else if (query.isError) {
			sawDisconnect.current = true;
			// Read before the status is written: the notification below is about
			// the transition, and only the previous value says whether this poll
			// is one.
			const previousStatus = useEngineStore.getState().engineStatus;
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
				query.error instanceof Error
					? query.error.message
					: "Couldn't connect to Vayu's engine.";
			setEngineError(errorMessage);
			// The transition, never each failed poll (#1358): a poll that fails is
			// already on the fast cadence, so re-posting would put one notification
			// on the user's screen every few hundred milliseconds. The Dock's dot
			// says the same thing for a user who is looking.
			if (previousStatus !== "unreachable") {
				systemNotify.post({
					kind: NOTIFY_KINDS.engineLost,
					title: "Vayu's engine stopped responding",
					body: errorMessage,
				});
			}
		}
	}, [
		query.isSuccess,
		query.isError,
		query.data,
		query.error,
		setEngineStatus,
		setEngineError,
		setEngineRecovery,
		setWorkers,
		closeEngineStartWindow,
		queryClient,
	]);

	return query;
}
