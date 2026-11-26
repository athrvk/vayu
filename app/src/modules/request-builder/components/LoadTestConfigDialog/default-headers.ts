/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Whether a load run's declared defaults differ from the Headers tab's (#1338). The tab renders
 * `GET /request-defaults?scope=design`, what sending *now* adds, read just before this dialog
 * opens; but `negotiateCompression` (design) and `loadNegotiateCompression` (load) can differ, so a
 * load run can send another `Accept-Encoding`. Component-free like `budgets.ts` and `monitor.ts`,
 * to test without rendering. Computed from the two engine answers only, never config entries: the
 * engine resolves which encodings it can negotiate, and deriving the set here is the defect (#1229)
 * the declared endpoint ends.
 */

import { pluralize } from "@/modules/dashboard/utils/format";
import type { RequestDefaultHeader, RequestDefaults } from "@/types";

function describeMissing(names: string[], verb: string): string | null {
	if (names.length === 0) return null;
	const list = names.join(", ");
	return `${list} ${pluralize(names.length, "is", "are")} ${verb}`;
}

/** `undefined` when the header has no value yet, a generated one included. */
function sameValue(a: RequestDefaultHeader, b: RequestDefaultHeader): boolean {
	return a.value === b.value;
}

/**
 * A sentence naming how a load run's default headers differ from the Headers tab's, or `null` when
 * they agree or either answer is missing (loading or errored): say nothing rather than guess.
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
