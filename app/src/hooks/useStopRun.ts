/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useStopLiveRun } from "./useStopLiveRun";

/**
 * Stop a run from a History tab: the request, the cache refresh that follows
 * it, and the toast when it fails. Shared by the collection-run tab and the
 * in-progress load-test pane, which are the two places a tab with no stream of
 * its own can cancel a run (`StopRunButton`).
 *
 * `stop` resolves once the request and the refresh are done and never throws.
 */
export function useStopRun(runId: string): { stop: () => Promise<void>; isStopping: boolean } {
	const { stop, isStopping } = useStopLiveRun();
	return { stop: () => stop({ kind: "collection", runId, label: null }), isStopping };
}
