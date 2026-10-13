/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What `runReference` reads, from either shape a run arrives in (#2047).
 *
 * A list row (`GET /runs`) carries the compact `summary`; a loaded run
 * (`GET /runs/:id`) carries no summary at all, only the full `configSnapshot`
 * the summary is cut from (`build_run_summary`,
 * `engine/src/http/routes/runs.cpp`). A surface holding a loaded run that read
 * `summary` would name every run by its kind alone, so every such surface maps
 * through here rather than picking fields itself.
 */

import { runReference, type RunReferenceInput } from "@/lib/agent-reference";
import type { Collection, Run, RunConfigSnapshot, RunScenarioSummary } from "@/types";

function stringField(snapshot: RunConfigSnapshot | undefined, key: string): string | undefined {
	const value = snapshot?.[key];
	return typeof value === "string" ? value : undefined;
}

/** The snapshot's scenario manifest, reduced to what a reference names. */
function snapshotScenario(snapshot: RunConfigSnapshot | undefined): RunScenarioSummary | undefined {
	const scenario = snapshot?.scenario;
	if (typeof scenario !== "object" || scenario === null) return undefined;
	const { collectionId } = scenario as { collectionId?: unknown };
	return typeof collectionId === "string" ? { collectionId } : {};
}

export function runReferenceInput(run: Run): RunReferenceInput {
	const snapshot = run.configSnapshot;
	const summary = run.summary;
	return {
		id: run.id,
		type: run.type,
		status: run.status,
		startTime: run.startTime,
		summary: {
			url: stringField(snapshot, "url") ?? summary?.url,
			method: stringField(snapshot, "method") ?? summary?.method,
			requestName: stringField(snapshot, "requestName") ?? summary?.requestName,
			scenario: snapshotScenario(snapshot) ?? summary?.scenario,
		},
	};
}

/** The run's line, a collection run named by its collection from the loaded tree. */
export function loadedRunReference(
	run: Run,
	collections: readonly Pick<Collection, "id" | "name">[]
): string {
	const input = runReferenceInput(run);
	const collectionId = input.summary?.scenario?.collectionId;
	const collectionName = collectionId
		? collections.find((c) => c.id === collectionId)?.name
		: undefined;
	return runReference(input, collectionName);
}
