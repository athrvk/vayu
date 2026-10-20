/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { HeaderLine, RedirectHop } from "@/types/domain";

/**
 * The lines the engine sent, or `undefined` when it sent none (issue #2460).
 *
 * "Absent" and "empty" are one case on purpose, and this is the one place that
 * says so. A live answer carries `headerLines: []` for a response with no
 * headers, a stored trace omits the key, and an engine or row from before the
 * key has neither - so treating only `undefined` as missing would let the same
 * exchange build a different `ResponseState` live and restored. Both funnels
 * run their input through here.
 *
 * Absence is kept, not filled in from the folded map, because it is the only
 * signal that the Cookies tab is holding a folded `set-cookie` rather than one
 * received line: a derived line looks exactly like a real one, and parsing a
 * folded value as a single line shows several cookies as one.
 */
export function receivedHeaderLines(lines: HeaderLine[] | undefined): HeaderLine[] | undefined {
	return lines && lines.length > 0 ? lines : undefined;
}

/**
 * The redirect hops the engine reported, or `undefined` when there were none
 * (issue #2461). Same rule as {@link receivedHeaderLines}: a live answer
 * always carries `redirects: []` while a stored trace writes the key only when
 * a hop was followed, so an empty list is an absent one or the same exchange
 * would build a different `ResponseState` live and restored.
 */
export function receivedRedirects(hops: RedirectHop[] | undefined): RedirectHop[] | undefined {
	return hops && hops.length > 0 ? hops : undefined;
}

/**
 * The header lines to display: the engine's when there are some, otherwise one
 * line per name of the folded map. For the tables and the Raw tab, which have
 * nothing better to show for a legacy row or a load-run sample.
 */
export function resolveHeaderLines(
	headers: Record<string, string> | undefined,
	lines: HeaderLine[] | undefined
): HeaderLine[] {
	return (
		receivedHeaderLines(lines) ??
		Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }))
	);
}

/**
 * The request's lines as the engine sent them, or `undefined` when it sent none
 * (issue #2466) - the request-side twin of {@link receivedHeaderLines}, with the
 * same reason for reading an empty list as an absent one. A live `/execute`
 * answer always carries `requestHeaderLines` (`[]` when nothing was recorded), a
 * stored trace omits the key, and an engine or row from before it has neither;
 * both funnels run their input through here so one exchange builds one
 * `ResponseState` live and restored.
 */
export function sentHeaderLines(lines: HeaderLine[] | undefined): HeaderLine[] | undefined {
	return receivedHeaderLines(lines);
}

/**
 * A `headers` payload field as lines, whichever shape it arrived in: the
 * ordered `[{ name, value }]` list `POST /compose` returns and a recorded run
 * snapshot may hold (issue #2466), or the older single-valued record, read in
 * its key order. The one place that says both are the same thing.
 */
export function headerLinesOf(
	headers: HeaderLine[] | Record<string, string> | undefined
): HeaderLine[] {
	if (!headers) return [];
	if (Array.isArray(headers)) return headers;
	return Object.entries(headers).map(([name, value]) => ({ name, value }));
}
