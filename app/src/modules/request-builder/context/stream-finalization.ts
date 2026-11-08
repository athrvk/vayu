/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * When a streamed run finishes, replace its live rows with what the run stored.
 *
 * The two-sources-one-list handoff `ScenarioRunView` makes, at the moment the
 * source changes: while the stream is open the Events tab reads
 * `execution-events-store`, and the completed run's trace is the record -
 * bounded by `sseMaxStoredEvents` and carrying the truthful `totalEvents` /
 * `eventsTruncated` markers, which the live list has no way to know. Without
 * this the tab would keep showing whatever happened to arrive on the socket,
 * and a switch to another request and back would show nothing at all, since
 * the durable copy of a response is the response store.
 *
 * Addressed to the request that streamed, not the one on screen (#3382), and
 * for two kinds of run: the stream the store holds, once its `complete` frame
 * has ended it, and every feed another request's stream took over, which
 * nothing relays any more and so is watched by polling the run until the
 * engine reports a terminal status.
 *
 * The report is fetched directly rather than through the last-design-run query
 * the cold-start restore uses: that query is keyed by request and its restore
 * is gated on having answered once, so waiting for it to refetch would race the
 * cache. Here the run id is already known.
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

/** Where a finalized run's response goes: the response store, and the pane if it is showing. */
export type LandStreamResponse = (requestId: string, response: ResponseState) => void;

/** The stored response with what only the Send knew put back on it. */
function withSendSnapshot(stored: ResponseState, claim: FinalizationClaim): ResponseState {
	const withSent = claim.sent ? { ...stored, sentRequest: claim.sent } : stored;
	return claim.leftOut.length > 0 ? { ...withSent, leftOutElements: claim.leftOut } : withSent;
}

/**
 * Fetch `runId`'s stored report and land it under the request that streamed.
 *
 * At most one finalisation per run, whoever asks: the claim lives in the store,
 * so a re-render, a StrictMode double effect or a builder remounted after the
 * user left for a settings tab all find it taken. Not cancelled by anything:
 * another request's Send can empty the store mid-fetch, and the run has
 * finished regardless.
 */
export async function finalizeStreamRun(runId: string, land: LandStreamResponse): Promise<void> {
	const claim = useExecutionEventsStore.getState().claimFinalization(runId);
	if (!claim) return;
	try {
		const report = await apiService.getRunReport(runId);
		const stored = responseFromRunResult(report?.results?.[0], runId);
		// A newer send of this request owns its response now.
		const { sendCounts } = useExecutionEventsStore.getState();
		const overtaken = (sendCounts[claim.requestId] ?? 0) !== claim.sends;
		if (stored && !overtaken) land(claim.requestId, withSendSnapshot(stored, claim));
	} catch {
		// The rows already on screen came from the stream itself and are still
		// true, so nothing is torn down. The claim is given back, so the next
		// mount of the builder fetches again; not retried in place, because an
		// engine that refused the report once would be asked in a loop.
		useExecutionEventsStore.getState().releaseFinalization(runId);
	}
	// A finished stream is a finished design run: History, the context bar's
	// Recent sends and the cold-start restore all read it, and nothing else
	// tells them.
	void queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() });
	void queryClient.invalidateQueries({ queryKey: queryKeys.runs.recentDesign(claim.requestId) });
	void queryClient.invalidateQueries({ queryKey: queryKeys.runs.lastDesign(claim.requestId) });
}

/** The ids of the watched runs the engine has settled. Module scope, so it is one function. */
function settledRunIds(results: QueryObserverResult<Run>[]): string[] {
	return results.flatMap((r) => (r.data && isRunTerminal(r.data.status) ? [r.data.id] : []));
}

/**
 * Finalize every streamed run this builder is owed, while `enabled`.
 *
 * Only the request builder's provider enables it: the History run view mounts
 * another `RequestBuilderProvider`, and two finalizers would race for the same
 * global store. A run that finishes while no builder is mounted (the user is on
 * a settings or run tab) is finalized when one mounts again.
 */
export function useStreamFinalization(enabled: boolean, land: LandStreamResponse): void {
	const endedRunId = useExecutionEventsStore((s) =>
		s.endReason && s.requestId ? s.runId : null
	);
	useEffect(() => {
		if (enabled && endedRunId) void finalizeStreamRun(endedRunId, land);
	}, [enabled, endedRunId, land]);

	// `runDetailOptions` polls a run only while it is in progress, which is
	// exactly the watch a replaced feed needs. A request's own re-send drops its
	// entry (`beginSend`), and with it the watch.
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
