/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The three-way merge behind #1437 and #1436, generalized past one caller.
 *
 * `InfoTab`'s `mergeField` proved the shape for a two-key draft compared by
 * `===` (both keys are plain strings, where that is value equality). The
 * request builder's draft has array- and object-valued fields (`headers`,
 * `params`, `auth`), which are rebuilt into fresh references on every fetch
 * regardless of content - `===` there would read every refetch as an external
 * change. `sameValue` compares by JSON content instead, the same rule
 * `useEntityDraft` already uses for its single-value case.
 *
 * A field with no external change is left alone. A changed field the caller
 * has not touched since the last known-good value is adopted silently. A
 * changed field the caller has touched, to the *same* value the fetch now
 * reports, is resolved with no conflict. Only a changed field the caller has
 * touched to a *different* value is a real conflict: the caller's value is
 * kept, and the incoming one is reported for the UI to offer.
 */

function sameValue<V>(a: V, b: V): boolean {
	if (Object.is(a, b)) return true;
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
}

/** A partial keyed by exactly the merge's field list, not every key of `T`. */
export type FieldPatch<T, K extends keyof T> = { [P in K]?: T[P] };

export interface FieldMergeOutcome<T, K extends keyof T> {
	/** Fields to adopt into the draft - untouched fields the fetch changed. */
	patch: FieldPatch<T, K>;
	/** `baseline` with every adopted or echoed-back field brought current. */
	nextBaseline: T;
	/** Touched fields whose external value differs from the draft's own. */
	conflicts: FieldPatch<T, K>;
	/** Whether any field differed from `baseline` at all - adopted or conflicted. */
	changed: boolean;
}

/**
 * Diff `incoming` against `baseline` over `fields`, adopting what the caller
 * has not touched and flagging the rest as conflicts.
 *
 * `baseline` is the value the draft last agreed with the server on, not
 * necessarily what is on screen now (`current`) - the same distinction
 * `useEntityDraft` draws. A field the caller touched and then set back to the
 * baseline's own value is not "touched" for this call: `touched` should
 * reflect that, not just "was ever edited".
 */
export function mergeExternalWrite<T, K extends keyof T>(
	fields: readonly K[],
	current: T,
	baseline: T,
	incoming: T,
	touched: ReadonlySet<K>
): FieldMergeOutcome<T, K> {
	const patch: FieldPatch<T, K> = {};
	const nextBaseline: T = { ...baseline };
	const conflicts: FieldPatch<T, K> = {};
	let changed = false;

	for (const field of fields) {
		const next = incoming[field];
		if (sameValue(next, baseline[field])) continue;
		changed = true;
		if (!touched.has(field)) {
			// Untouched: the fetch's value wins, silently.
			patch[field] = next;
			nextBaseline[field] = next;
		} else if (sameValue(next, current[field])) {
			// Touched, but the fetch now agrees with the draft (our own save
			// landed, or a coincidence) - nothing to adopt, just catch baseline up.
			nextBaseline[field] = next;
		} else {
			// Touched, and the fetch disagrees with the draft: a real conflict.
			// `baseline` is deliberately left at its old value so this keeps
			// being detected on every render until `takeExternalField` resolves it.
			conflicts[field] = next;
		}
	}

	return { patch, nextBaseline, conflicts, changed };
}
