/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Keep the engine store's `engineCrash` in step with the sidecar's lifecycle
 * (#3336): the pushed transitions, plus one read of the current state for a
 * window that loaded after the last push.
 *
 * Facts only. `engineStatus` stays the health poll's verdict
 * (`lib/engine-start-window.ts`); this explains an unreachable engine and
 * lets the Dock offer Restart. A crash also asks the poll to look again rather
 * than wait out `HEALTH_CHECK_INTERVAL_MS` (#3493): the health query and nothing
 * else, since every other query is the reconnect's to refetch. A crash that
 * lands inside a restart's start window is safe to ask about, because the poll
 * classifies a failure there as `starting`.
 *
 * Pushes arrive in the order the sidecar made them, so each one simply
 * replaces the last, with one exception: a crash is only ended by an engine
 * that is up or was stopped on purpose (`ready`, `slow`, `stopping`,
 * `stopped`). A restart from a crash pushes `replacing`, `choosingPort` and
 * `spawning`, and one that fails before a child exists lands on `idle`; if
 * those cleared the crash the Dock would lose both its sentence and its
 * Restart button, leaving "Engine disconnected" and no way back. The snapshot is the only reply that can be older than
 * what the window already knows, and it yields to both signs of that: a push
 * that landed while it was in flight, and a restart that opened a new start
 * window (the same guard `adoptEngineStartFailure` applies in
 * `queries/health.ts`). Letting it speak then would put a crash back over the
 * engine replacing it.
 */

import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/queries/keys";
import { useEngineStore } from "@/stores";
import type { EngineLifecyclePayload } from "@/types/electron";

/** Kinds that leave a recorded crash standing: the engine is between processes. */
const CRASH_SURVIVES: ReadonlySet<EngineLifecyclePayload["kind"]> = new Set([
	"idle",
	"choosingPort",
	"replacing",
	"spawning",
]);

function applyEngineLifecycle(lifecycle: EngineLifecyclePayload, queryClient: QueryClient): void {
	const { setEngineCrash } = useEngineStore.getState();
	if (lifecycle.kind === "crashed") {
		const { code, signal, stderrTail, error } = lifecycle;
		setEngineCrash({ code, signal, stderrTail, error });
		void queryClient.invalidateQueries({ queryKey: queryKeys.health.status() });
		return;
	}
	if (CRASH_SURVIVES.has(lifecycle.kind)) return;
	setEngineCrash(null);
}

export function useEngineLifecycle(): void {
	const queryClient = useQueryClient();

	useEffect(() => {
		const api = window.electronAPI;
		// Absent in the dev browser: there is no sidecar to report.
		if (!api?.onEngineLifecycle || !api.getEngineLifecycle) return;

		let pushed = false;
		let disposed = false;
		const startedIn = useEngineStore.getState().engineStartWindow;

		// Subscribed before the read, so a transition between the two is not lost.
		const unsubscribe = api.onEngineLifecycle((lifecycle) => {
			pushed = true;
			applyEngineLifecycle(lifecycle, queryClient);
		});

		api.getEngineLifecycle()
			.then((lifecycle) => {
				if (disposed || pushed) return;
				if (useEngineStore.getState().engineStartWindow !== startedIn) return;
				applyEngineLifecycle(lifecycle, queryClient);
			})
			.catch(() => {
				// The main process cannot be asked; the next push still arrives, and a
				// failure to describe the engine must not add a second one.
			});

		return () => {
			disposed = true;
			unsubscribe();
		};
	}, [queryClient]);
}
