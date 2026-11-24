/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * When a streamed run finishes, replace its live rows with what the run stored: the
 * two-sources-one-list handoff `ScenarioRunView` makes, at the moment the source changes. Open, the
 * Events tab reads `execution-events-store`; the finished trace is the record, bounded by
 * `sseMaxStoredEvents` with the truthful `totalEvents` / `eventsTruncated` the live list cannot
 * know. Without this the tab keeps whatever arrived on the socket, and switching away and back
 * shows nothing, as the response store is the durable copy. Addressed to the request that streamed,
 * not the one on screen (#3382), for the stream the store holds once its `complete` frame ends it,
 * and for every feed another request's stream took over, which nothing relays, so the run is polled
 * until terminal. The report is fetched directly, not through the last-design-run query: that query
 * is request-keyed with a restore gated on one answer, so waiting for its refetch would race the
 * cache, and the run id is known.
 */

import { useEffect, useMemo } from "react";
import { useQueries, type QueryObserverResult } from "@tanstack/react-query";
import { apiService } from "@/services";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/queries";
import { runDetailOptions } from "@/queries/runs";
import { isRunTerminal } from "@/lib/run-status";
import { useExecutionEventsStore, type FinalizationClaim } from "@/stores/execution-events-store";
import type { Run } from "@/types";
import type { ResponseState } from "../types";
import { responseFromRunResult } from "../utils/restore-response";
import { appendSendToConsole } from "@/modules/console";

/** Where a finalized run's response goes: the response store, and the pane if it is showing. */
export type LandStreamResponse = (requestId: string, response: ResponseState) => void;

/** The stored response with what only the Send knew put back on it. */
function withSendSnapshot(stored: ResponseState, claim: FinalizationClaim): ResponseState {
	return {
		...stored,
		...(claim.sent && { sentRequest: claim.sent }),
		...(claim.sentAt !== null && { sentAt: claim.sentAt }),
		...(claim.leftOut.length > 0 && { leftOutElements: claim.leftOut }),
	};
}

/**
 * Fetch `runId`'s stored report and land it under the request that streamed. At most once per run:
 * the claim is in the store, so a re-render, a StrictMode double effect or a remount after a
 * settings tab all find it taken. Never cancelled: another Send can empty the store mid-fetch, and
 * the run is finished regardless.
 */
export async function finalizeStreamRun(runId: string, land: LandStreamResponse): Promise<void> {
	const claim = useExecutionEventsStore.getState().claimFinalization(runId);
	if (!claim) return;
	try {
		const report = await apiService.getRunReport(runId);
		const result = report?.results?.[0];
		const stored = responseFromRunResult(result, runId);
		// Before the overtaken skip: a newer Send owns the pane, but this one was sent, and the
		// claim keeps it to one append per run.
		if (stored) {
			appendSendToConsole({
				method: result?.trace?.request?.method ?? "",
				url: result?.trace?.request?.url ?? "",
				response: stored,
				requestId: claim.requestId,
				runId,
			});
		}
		// A newer send of this request owns its response now.
		const { sendCounts } = useExecutionEventsStore.getState();
		const overtaken = (sendCounts[claim.requestId] ?? 0) !== claim.sends;
		if (stored && !overtaken) land(claim.requestId, withSendSnapshot(stored, claim));
	} catch {
		// The rows on screen came from the stream and are still true, so nothing is torn down. The
		// claim is returned so the next mount fetches again; no retry in place, which would loop on
		// a refusing engine.
		useExecutionEventsStore.getState().releaseFinalization(runId);
	}
	// A finished stream is a finished design run: History, Recent sends and the cold-start restore
	// read it, and nothing else tells them.
	void queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() });
	void queryClient.invalidateQueries({ queryKey: queryKeys.runs.recentDesign(claim.requestId) });
	void queryClient.invalidateQueries({ queryKey: queryKeys.runs.lastDesign(claim.requestId) });
}

/** The ids of the watched runs the engine has settled. Module scope, so it is one function. */
function settledRunIds(results: QueryObserverResult<Run>[]): string[] {
	return results.flatMap((r) => (r.data && isRunTerminal(r.data.status) ? [r.data.id] : []));
}

/**
 * Finalize every streamed run this builder is owed, while `enabled`. Only the request builder's
 * provider enables it: History's run view mounts another provider, and two finalizers would race
 * for one global store. A run finishing with no builder mounted is finalized when one mounts.
 */
export function useStreamFinalization(enabled: boolean, land: LandStreamResponse): void {
	const endedRunId = useExecutionEventsStore((s) =>
		s.endReason && s.requestId ? s.runId : null
	);
	useEffect(() => {
		if (enabled && endedRunId) void finalizeStreamRun(endedRunId, land);
	}, [enabled, endedRunId, land]);

	// `runDetailOptions` polls a run only while in progress, the watch a replaced feed needs; a
	// re-send drops its entry (`beginSend`), and the watch with it.
	const replacedFeeds = useExecutionEventsStore((s) => s.replacedFeeds);
	const watched = useMemo(
		() => (enabled ? Object.values(replacedFeeds).map((feed) => feed.runId) : []),
		[enabled, replacedFeeds]
	);
	const settled = useQueries({
		queries: watched.map((runId) => runDetailOptions(runId)),
		combine: settledRunIds,
	});
	useEffect(() => {
		for (const runId of settled) void finalizeStreamRun(runId, land);
	}, [settled, land]);
}
