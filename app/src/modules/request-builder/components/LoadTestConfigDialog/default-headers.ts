/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Whether a load run's declared defaults differ from the Headers tab's
 * (issue #1338).
 *
 * The Headers tab renders `GET /request-defaults?scope=design` - what sending
 * the request *right now* would add - and that is the answer a user reads
 * immediately before opening this dialog. But `negotiateCompression` (design)
 * and `loadNegotiateCompression` (load) can be set differently, so the same
 * request can get a different `Accept-Encoding` on a load run than the tab
 * just showed. Kept component-free, like `budgets.ts` and `monitor.ts` beside
 * it, so the comparison is testable without rendering.
 *
 * Computed from the two ENGINE answers only, never from config entries: the
 * engine already resolves which encodings it can even negotiate, so working
 * the set out here a second time is exactly the defect (#1229) the declared
 * endpoint exists to end.
 */

import type { RequestDefaultHeader, RequestDefaults } from "@/types";

function describeMissing(names: string[], verb: string): string | null {
	if (names.length === 0) return null;
	const list = names.join(", ");
	return `${list} ${names.length === 1 ? "is" : "are"} ${verb}`;
}

/** `undefined` when the header carries no value yet - a generated one included. */
function sameValue(a: RequestDefaultHeader, b: RequestDefaultHeader): boolean {
	return a.value === b.value;
}

/**
 * One sentence naming how a load run's default headers differ from the
 * Headers tab's, or `null` when they agree.
 *
 * `null` while either answer has not arrived yet (the query is still
 * loading, or errored) - the dialog says nothing rather than guess ahead of
 * the engine.
 */
export function describeDefaultHeaderDifference(
	design: RequestDefaults | undefined,
	load: RequestDefaults | undefined
): string | null {
	if (!design || !load) return null;

	const designByName = new Map(design.headers.map((h) => [h.name, h]));
	const loadByName = new Map(load.headers.map((h) => [h.name, h]));

	const onlyOnDesign: string[] = [];
	const changedValue: string[] = [];
	for (const [name, designHeader] of designByName) {
		const loadHeader = loadByName.get(name);
		if (!loadHeader) {
			onlyOnDesign.push(name);
		} else if (!sameValue(designHeader, loadHeader)) {
			changedValue.push(name);
		}
	}

	const onlyOnLoad: string[] = [];
	for (const name of loadByName.keys()) {
		if (!designByName.has(name)) onlyOnLoad.push(name);
	}

	if (onlyOnDesign.length === 0 && onlyOnLoad.length === 0 && changedValue.length === 0) {
		return null;
	}

	const clauses = [
		describeMissing(onlyOnDesign, "on the Headers tab but not on this load run"),
		describeMissing(onlyOnLoad, "on this load run but not on the Headers tab"),
		describeMissing(changedValue, "sent with a different value on this load run"),
	].filter((clause): clause is string => clause !== null);

	return `${clauses.join("; ")}.`;
}
