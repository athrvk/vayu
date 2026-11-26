/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useBaselineRunQuery, useRunQuery, type BaselineTarget } from "@/queries";
import { runIdentity, runReferenceInput } from "@/lib/run-reference-input";
import type { RunReferenceInput } from "@/lib/agent-reference";
import type { Run } from "@/types";

export interface PinnedBaseline {
	/** The open run's row, which carries the identity the pin is found by. */
	run: Run | undefined;
	/** `run` mapped for a reference line, or `null` until it loads. */
	target: RunReferenceInput | null;
	/** The run pinned for the same request or collection, which may be the open run itself. */
	baselineRun: Run | null | undefined;
	/** `baselineRun`'s id when it is a run other than the open one, else `null`. */
	baselineId: string | null;
}

/**
 * The run pinned as the baseline for the open run's request or collection.
 *
 * The run row is fetched, not passed in: the report does not carry the run's identity (`requestId`
 * and the collection are the run's properties, not its aggregates'), and every caller sits under a
 * pane that loaded this exact query, so the shared cache answers without a second request.
 *
 * A saved request is matched by id and a scenario load run by its collection (`runIdentity`); a run
 * of an unsaved request has only the url and method its row recorded (see `useBaselineRunQuery`),
 * and the report's `metadata` (`requestUrl` / `requestMethod` here) stands in where the row's
 * snapshot has neither. Primitives, so a memo'd caller can pass them through.
 */
export function usePinnedBaseline(
	runId: string,
	requestUrl?: string | null,
	requestMethod?: string | null
): PinnedBaseline {
	const { data: run } = useRunQuery(runId || null);
	const target = run ? runReferenceInput(run) : null;
	const url = target?.summary?.url ?? requestUrl;
	const method = target?.summary?.method ?? requestMethod;
	const lookup: BaselineTarget | null = run
		? (runIdentity(run) ?? (url && method ? { url, method } : null))
		: null;
	const { data: baselineRun } = useBaselineRunQuery(lookup);
	// The run being viewed is often the pinned one, and comparing it with itself
	// says nothing.
	const baselineId = baselineRun && baselineRun.id !== runId ? baselineRun.id : null;
	return { run, target, baselineRun, baselineId };
}
