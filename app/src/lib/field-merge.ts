/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The three-way merge behind #1437 and #1436, for any draft.
 *
 * Fields compare by JSON content (`sameValue`), the rule `useEntityDraft` uses for its single
 * value. `InfoTab`'s own `mergeField` compares by `===`, which is value equality for its two
 * plain-string keys, but the request builder's array- and object-valued fields (`headers`,
 * `params`, `auth`) are rebuilt into fresh references on every fetch, so `===` would read every
 * refetch as an external change. A field whose content carries more than its stored value (a
 * table's ephemeral row ids, #3663) names its own rule in `MergeOptions.equals`.
 *
 * A field with no external change is left alone. A changed field the caller has not touched since
 * the last known-good value is adopted silently. A touched field the fetch now reports at the
 * draft's own value, or at a value one of the caller's saves sent (`MergeOptions.sent`, #3664),
 * resolves with no conflict. Only a touched field whose incoming value neither the draft nor its
 * saves hold is a real conflict: the caller's value is kept, and the incoming one is reported for
 * the UI to offer.
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

export interface MergeOptions<T, K extends keyof T> {
	/** Per-field equality, used in place of `sameValue` for every compare of that field. */
	equals?: { [P in K]?: (a: T[P], b: T[P]) => boolean };
	/**
	 * What the caller's recent saves sent, one patch per save holding the fields it sent. An
	 * incoming value equal to any of them is that save's echo: a keystroke during the round trip
	 * leaves the draft ahead of it, and without this the echo would read as someone else's write.
	 * Keyed on the value, not on a save being in flight, so an outside write in the same window
	 * still conflicts, unless it writes a value one of these saves sent, which is indistinguishable
	 * from that save's echo.
	 */
	sent?: readonly FieldPatch<T, K>[];
}

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
 * Diff `incoming` against `baseline` over `fields`, adopting what the caller has not touched and
 * flagging the rest as conflicts. `baseline` is the value the draft last agreed with the server on,
 * not necessarily what is on screen (`current`), the distinction `useEntityDraft` draws. A field
 * the caller touched and then set back to the baseline's value is not touched for this call:
 * `touched` should reflect that, not "was ever edited".
 *
 * `options.equals` replaces the JSON compare for the fields it names in all three tests: did the
 * fetch change it, does the draft already agree, is it our save's echo.
 */
export function mergeExternalWrite<T, K extends keyof T>(
	fields: readonly K[],
	current: T,
	baseline: T,
	incoming: T,
	touched: ReadonlySet<K>,
	options: MergeOptions<T, K> = {}
): FieldMergeOutcome<T, K> {
	const patch: FieldPatch<T, K> = {};
	const nextBaseline: T = { ...baseline };
	const conflicts: FieldPatch<T, K> = {};
	const sent = options.sent ?? [];
	let changed = false;

	for (const field of fields) {
		const same: (a: T[K], b: T[K]) => boolean = options.equals?.[field] ?? sameValue;
		const next = incoming[field];
		if (same(next, baseline[field])) continue;
		changed = true;
		const isEcho = sent.some((saved) => field in saved && same(next, saved[field] as T[K]));
		if (!touched.has(field)) {
			// Untouched: the fetch's value wins, silently.
			patch[field] = next;
			nextBaseline[field] = next;
		} else if (same(next, current[field]) || isEcho) {
			// Touched, but the fetch agrees with the draft (our own save landed, or a coincidence)
			// or with what our save sent while the draft moved on: nothing to adopt, just catch
			// baseline up. The field stays touched, so the next save still sends the newer draft.
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
