/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What an engine that does not answer means, given the start it failed on.
 *
 * Two readers ask this: the health poll, which turns the answer into the Dock's
 * `starting` / `unreachable`, and the shared query retry policy
 * (`lib/query-client.ts`), which keeps every other query loading rather than
 * failed while the answer is `starting`. They live here rather than in
 * `queries/health.ts` because the query client cannot import that module:
 * `health.ts` reaches `services/api.ts`, which imports the query client.
 */

import { useEngineStore } from "@/stores/engine-store";
import { TIMING } from "@/config/timing";

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
 * Derived in the renderer rather than pushed from the main process. `sidecar.ts`
 * knows more precisely - it holds the child handle and raises
 * `EngineNotReadyError` on the same budget - but `preload.ts` exposes no
 * engine-status channel, and adding one to say something the renderer's own poll
 * already knows would be a second source of truth for one label.
 */
export function engineStatusAfterFailedPoll(
	windowOpenedAt: number | null,
	now: number
): "starting" | "unreachable" {
	if (windowOpenedAt === null) return "unreachable";
	return now - windowOpenedAt < TIMING.ENGINE_STARTUP_GRACE_MS ? "starting" : "unreachable";
}

/**
 * Whether a failure right now would still be a start rather than a lost engine.
 * Read from the store when asked, never subscribed: the callers are per-attempt
 * callbacks, and a subscription would re-render for a value only they consult.
 */
export function engineStarting(): boolean {
	return (
		engineStatusAfterFailedPoll(useEngineStore.getState().engineStartWindow, Date.now()) ===
		"starting"
	);
}
