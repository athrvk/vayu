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
 * The key a record is filed under while the builder names no identity at all -
 * the provider's one fallback, read by the Send-with-row picker's memory as
 * well as by the slots here (issue #1271). One convention spelled twice is how
 * two spellings of it drift apart.
 *
 * A builder says which identity it files under with the provider's `memoryKey`
 * prop, defaulting to `request.id`. A request tab is always opened against a
 * request the backend has already created (`useNewRequest`), and the editable
 * copy History renders for a stored run - the one builder with no request id -
 * passes its run id (issue #1272), so nothing reaches this key in the app
 * today. It stays as the answer for a builder that has neither, because the
 * alternative is every such builder sharing whichever key was written last:
 * the rules read a `requestId` of `null` against another `null` as a match, so
 * a shared bucket is handed out as owned rather than refused.
 *
 * It is the one key the open-tab sweep never drops. That is what it costs: a
 * key naming no tab cannot be bounded by the tabs, which is the second reason
 * to declare an identity that does.
 */
export const UNSAVED_AUTO_KEY = "__unsaved__";

interface AutoRecordSlot<T> {
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
 * @param requestKey which builder the accessors read and write for - the
 * provider's resolved `memoryKey`: the request's id, the identity a builder
 * over something else declared, or {@link UNSAVED_AUTO_KEY} when it has
 * neither.
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
