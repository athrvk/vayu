/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One reversible-side-effect record *per request*, for one setting (issue
 * #1269).
 *
 * The three settings that change something on their way in - the body mode's
 * `Content-Type`, the Event stream toggle's `Accept`, the GraphQL mode's `POST`
 * - each remember what they changed so that leaving the setting can take it
 * back. Each record names the request it belongs to and the rules that read
 * them (`utils/auto-header.ts`, `panels/body/graphql-method.ts`) drop one
 * naming another request, which is the right answer to "is this record mine?"
 * and no answer at all to "where did the other request's record go?": one
 * `RequestBuilderProvider` serves every request tab, so a single slot per
 * setting meant the second request into a mode overwrote the first one's
 * record, and the first request kept the header row - or the method - the app
 * had changed for it, with nothing left that knew it was the app's.
 *
 * So the storage is keyed the way the record always was. The accessors stay
 * argument-free: the provider knows which request is on screen, and a caller
 * that had to pass the id could pass the wrong one.
 */

import { useCallback, useRef } from "react";

/**
 * The key a record is filed under while the builder holds no saved request.
 *
 * Shares one bucket for every such builder, which is what the rules already do
 * with a `requestId` of `null` - `null === null` passes their ownership check.
 * A request tab is always opened against a request the backend has already
 * created (`useNewRequest`), so the only builder that reaches this key is the
 * read-only copy History renders for a stored run.
 */
export const UNSAVED_AUTO_KEY = "__unsaved__";

export interface AutoRecordSlot<T> {
	/** The record for the request on screen, or null if it has none. */
	get: () => T | null;
	/** Files a record against the request on screen; null forgets it. */
	set: (record: T | null) => void;
	/**
	 * Drops every record whose key is not in `live`. Stable across renders, so
	 * a subscription can hold it.
	 */
	retain: (live: ReadonlySet<string>) => void;
}

/**
 * @param requestKey which request the accessors read and write - `request.id`,
 * or {@link UNSAVED_AUTO_KEY} when there is none.
 */
export function useAutoRecordSlot<T>(requestKey: string): AutoRecordSlot<T> {
	const byRequest = useRef(new Map<string, T>());

	const get = useCallback(() => byRequest.current.get(requestKey) ?? null, [requestKey]);

	const set = useCallback(
		(record: T | null) => {
			if (record === null) byRequest.current.delete(requestKey);
			else byRequest.current.set(requestKey, record);
		},
		[requestKey]
	);

	const retain = useCallback((live: ReadonlySet<string>) => {
		for (const key of byRequest.current.keys()) {
			if (!live.has(key)) byRequest.current.delete(key);
		}
	}, []);

	return { get, set, retain };
}
