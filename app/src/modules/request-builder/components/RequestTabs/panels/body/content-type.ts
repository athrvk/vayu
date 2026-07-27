/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Choosing GraphQL adds a header to the request, which is a side effect on a
 * tab you are not looking at.
 *
 * The rule is small but it is a *rule* - "does this mode require a Content-Type,
 * and does the request already carry one" - so it lives here rather than inside
 * a click handler, where the only way to exercise it is to drive a Radix Select
 * through jsdom.
 */

import type { BodyMode, KeyValueItem } from "../../../../types";
import { generateId } from "../../../../utils/id";

export const CONTENT_TYPE = "Content-Type";

/** GraphQL is sent as a JSON envelope: `{ query, variables }`. */
const REQUIRED_CONTENT_TYPE: Partial<Record<BodyMode, string>> = {
	graphql: "application/json",
};

const isContentType = (item: KeyValueItem) =>
	item.key.trim().toLowerCase() === CONTENT_TYPE.toLowerCase();

/**
 * The Content-Type this mode change should add, or null if none is needed.
 *
 * Null when the mode requires nothing, and null when the request already
 * declares one - including a *different* one, which is deliberate: someone who
 * has set `application/graphql` by hand means it, and silently replacing it
 * would be a worse version of the bug this whole thing is about.
 *
 * A disabled Content-Type row does not count as declaring one - it is not sent,
 * so the request would go out without the header.
 */
export function contentTypeToAdd(mode: BodyMode, headers: KeyValueItem[]): string | null {
	const required = REQUIRED_CONTENT_TYPE[mode];
	if (!required) return null;
	return headers.some((h) => isContentType(h) && h.enabled) ? null : required;
}

/** The header list with the row this panel added taken back out. */
export function withoutContentType(headers: KeyValueItem[], value: string): KeyValueItem[] {
	return headers.filter((h) => !(isContentType(h) && h.value === value));
}

/** The header row to append, ready for `updateField("headers", …)`. */
export function contentTypeRow(value: string): KeyValueItem {
	return { id: generateId(), key: CONTENT_TYPE, value, enabled: true };
}
