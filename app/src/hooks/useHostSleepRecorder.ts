/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Turn the main process's suspend / resume pair into one annotation on the run
 * that was streaming when the host went down (issue #1357).
 *
 * Two events rather than one because each carries half the answer: the suspend
 * is the last moment the renderer can read where the run had got to, and the
 * resume is the only thing that knows how long the machine was gone. Between
 * them the renderer is frozen, so the anchor has to be taken on the way down.
 *
 * A collection run holds the wake lock too, but records nothing: its tab is a
 * list of steps with no time axis and no Events surface, so there is nowhere to
 * put a marker that a reader would find. The lock is the part that matters
 * there.
 */

import { useEffect, useRef } from "react";
import { useDashboardStore } from "@/stores";
import { useHostSleepStore } from "@/stores/host-sleep-store";

/** Where a run had got to when the host went down. */
interface SuspendAnchor {
	runId: string;
	startSeconds: number;
}

/** The run streaming right now, and its elapsed position - or null if none is. */
function streamingAnchor(): SuspendAnchor | null {
	const { currentRunId, isStreaming, currentMetrics } = useDashboardStore.getState();
	if (!currentRunId || !isStreaming) return null;
	return { runId: currentRunId, startSeconds: currentMetrics?.elapsed_seconds ?? 0 };
}

export function useHostSleepRecorder(): void {
	const anchor = useRef<SuspendAnchor | null>(null);

	useEffect(() => {
		const api = window.electronAPI;
		if (!api?.onHostSuspended || !api.onHostResumed) return;

		const stopSuspend = api.onHostSuspended(() => {
			anchor.current = streamingAnchor();
		});

		const stopResume = api.onHostResumed(({ at, durationMs }) => {
			const pending = anchor.current;
			anchor.current = null;
			// No run was streaming when the host went down, so there is no series
			// with a hole in it to explain.
			if (!pending) return;
			useHostSleepStore.getState().recordSleep(pending.runId, {
				at: at - durationMs,
				durationMs,
				startSeconds: pending.startSeconds,
			});
		});

		return () => {
			stopSuspend();
			stopResume();
		};
	}, []);
}
