/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What an engine that does not answer means, given the start it failed on. Two readers ask: the
 * health poll, which turns the answer into the Dock's `starting` / `unreachable`, and the shared
 * query retry policy (`lib/query-client.ts`), which keeps every other query loading rather than
 * failed while the answer is `starting`. Not in `queries/health.ts`, because the query client
 * cannot import it: `health.ts` reaches `services/api.ts`, which imports the query client.
 */

import { useEngineStore } from "@/stores/engine-store";
import { TIMING } from "@/config/timing";

/**
 * What a failed poll means, given the start it failed on. A refused connection is the same
 * transport error either way, so only whether a start is in flight can tell an engine coming up
 * from one that is not coming. `windowOpenedAt` is `null` when none is, and an engine that answered
 * with nothing starting is unreachable at once, with no grace: it proved it could serve, so its
 * silence is news.
 *
 * Judged against the window, not the session's age: the app restarts the engine itself
 * (`useEngineRestart`), and the process that comes back does the same cold-start work as the first.
 * Judged by the session, every restart would read as a failure, since an engine (the one it
 * replaced) had answered (#1227).
 *
 * Derived in the renderer, and this poll is the only classifier. The main process pushes its
 * sidecar's lifecycle (`engine:lifecycle`, `hooks/useEngineLifecycle`) as facts: `engineCrash`
 * explains an unreachable engine and lets the Dock offer Restart, and never writes `engineStatus`.
 * A second writer would give one label two sources, one of them a push that can arrive before or
 * after the poll that confirms it.
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

/**
 * Why the main process left the app without an engine, when the user can act on it (#2118): today,
 * another program holding every port the engine may use. `null` when there is none, outside
 * Electron, and when the main process cannot be asked: the poll that asks is already reporting a
 * failure, and failing to describe it must not add a second.
 */
export async function readEngineStartFailure(): Promise<string | null> {
	try {
		return (await window.electronAPI?.getEngineStartFailure()) ?? null;
	} catch {
		return null;
	}
}
