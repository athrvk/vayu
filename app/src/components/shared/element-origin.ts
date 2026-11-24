/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ElementOrigin } from "@/types/domain";

/**
 * Where an element row came from, for the one case worth saying (#3051): a collection's element on
 * a request not owning it. A request's own element needs no line, and the engine names a folder's
 * level with the `collection` kind, which the UI calls a collection throughout
 * (`docs/ux-writing.md`). `undefined` prints nothing, as for an inline send with no origin.
 */
export function elementOriginLabel(origin: ElementOrigin | undefined): string | undefined {
	if (origin?.kind !== "collection") return undefined;
	return origin.name ? `from "${origin.name}"` : "from a collection";
}

/**
 * One element tally row's React key. An id is unique only within its level (#3101), so a report can
 * hold one id twice; the origin joins the id, as the engine tells the rows apart. A row with no
 * origin falls back to its position: a report predating origins can repeat an id with nothing else
 * to separate them.
 */
export function elementRowKey(
	element: { id: string; origin?: ElementOrigin },
	index: number
): string {
	const { origin } = element;
	if (!origin) return `${index}:${element.id}`;
	return `${origin.kind}/${origin.scope ?? ""}/${origin.id ?? ""}:${element.id}`;
}
