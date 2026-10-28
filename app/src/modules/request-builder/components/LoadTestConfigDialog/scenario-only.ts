/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The elements a single-request load test cannot run (#3050), found before
 * Start so the engine's refusal is not the first the user hears of them.
 *
 * `GET /elements/kinds` carries no flag for this: the engine decides it with a
 * whitelist in `load_strategy.cpp` (`REQUEST_ELEMENTS_SUPPORTED_KINDS`), so the
 * names are repeated here. `scenario-only.conformance.test.ts` pins them to the
 * engine's catalogue fixture, so a new `control.*` or `metric.*` kind is a red
 * test rather than a refusal at Start.
 */

import { pickByCount } from "@/modules/dashboard/utils/format";
import type { ResolvedElement } from "@/types";

/** Kinds that need a scenario's state: a pacing clock, a throughput share, a plan scan, a custom series. */
const SCENARIO_ONLY_FAMILIES = ["control.", "metric."] as const;
const SCENARIO_ONLY_KINDS: ReadonlySet<string> = new Set(["timer.pacing", "timer.throughput"]);

export function isScenarioOnlyKind(kind: string): boolean {
	return SCENARIO_ONLY_KINDS.has(kind) || SCENARIO_ONLY_FAMILIES.some((f) => kind.startsWith(f));
}

/**
 * The enabled scenario-only elements in a resolved list. A disabled one is
 * left out: the engine skips it too, and the run sends no disabled element
 * (`withoutDisabled`).
 */
export function scenarioOnlyElements(parts: readonly ResolvedElement[] | undefined) {
	return (parts ?? []).filter((el) => el.enabled && isScenarioOnlyKind(el.kind));
}

/** Where an element was declared: this request, or the collection or folder it is inherited from. */
function describeOrigin({ origin }: ResolvedElement): string {
	if (!origin || origin.kind === "request") return "set on this request";
	const level = origin.scope === "folder" ? "folder" : "collection";

	return origin.name
		? `inherited from the ${level} '${origin.name}'`
		: `inherited from a ${level}`;
}

/**
 * The sentence that stops Start, or null when nothing needs a scenario. It
 * names each element and its origin: a request inherits elements the user may
 * never have opened, so "remove the pacing" is not actionable without the
 * place to remove it from.
 */
export function scenarioOnlyError(elements: readonly ResolvedElement[]): string | null {
	if (elements.length === 0) return null;
	const named = elements.map((el) => `${el.kind} (${describeOrigin(el)})`).join("; ");

	const them = pickByCount(elements.length, { one: "it", other: "them" });

	return `A single-request load test can't run ${named}. Disable or remove ${them}, or run the collection instead.`;
}
