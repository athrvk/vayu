/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A collection run's `scenario` block, read out of the run's stored snapshot.
 *
 * `RunConfigSnapshot` is typed for a load run's flat keys and carries an index
 * signature for everything else, so the block arrives as `unknown`. Narrowing
 * it once, here, is what keeps two context-bar sections from each writing their
 * own cast - and what makes the "which parts are actually present" question
 * answerable in a unit test rather than by opening the bar.
 *
 * What the engine writes is `build_scenario_manifest`
 * (`engine/src/core/scenario_plan.cpp`), placed on the snapshot by
 * `scenario_snapshot` (`engine/src/http/routes/execution.cpp`) - the raw
 * `scenario` block the client sent is *replaced* by the resolved manifest, so
 * what is read back is the plan that ran, not the request for one. Every field
 * is optional here for the same reason the app never trusts a shape it did not
 * validate: a run stored by an older engine, or a snapshot that failed to
 * sanitize, must render as "nothing recorded" rather than throw.
 */

import type { Run } from "@/types";

/** One resolved step of the plan, as the snapshot's manifest records it. */
export interface ScenarioSnapshotStep {
	index?: number;
	requestId?: string;
	name?: string;
	method?: string;
	/** The **stored** url - uncomposed, so it never carries a resolved secret. */
	url?: string;
}

export interface ScenarioSnapshot {
	source?: string;
	collectionId?: string;
	recursive?: boolean;
	iterations?: number;
	steps?: ScenarioSnapshotStep[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The scenario block of a run, or `null` for a run that has none.
 *
 * Gated on `run.type` as well as the key: `type` is what every other surface
 * branches on, and a load run whose snapshot happened to carry a `scenario` key
 * (a hand-rolled `POST /runs` body the engine ignored) is not a collection run
 * and must not render as one.
 */
export function scenarioFromSnapshot(run: Run | undefined): ScenarioSnapshot | null {
	if (run?.type !== "scenario") return null;
	const block = run.configSnapshot?.scenario;
	if (!isRecord(block)) return null;

	const steps = Array.isArray(block.steps)
		? block.steps.filter(isRecord).map((step) => ({
				index: num(step.index),
				requestId: str(step.requestId),
				name: str(step.name),
				method: str(step.method),
				url: str(step.url),
			}))
		: undefined;

	return {
		source: str(block.source),
		collectionId: str(block.collectionId),
		recursive: typeof block.recursive === "boolean" ? block.recursive : undefined,
		iterations: num(block.iterations),
		steps,
	};
}
