/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Keep the end of a URL when there is not room for all of it (#1691).
 *
 * CSS `truncate` cuts the tail, which is exactly backwards for a URL: the part
 * that identifies one row is the path, and the part every row shares is the
 * scheme and the host. A page of unsaved local runs read
 * `http://127.0.0.1:9...` five times over - five identical rows for five
 * different requests.
 *
 * So the head gives way and the tail does not. The result is a *display* string
 * and nothing else: it is never parsed, never sent, and the full value stays one
 * hover away in the element's `title`.
 *
 * This is deliberately not a `new URL()` job. A row can hold a value that is
 * still being typed, one carrying `{{variables}}` in the authority, or a
 * relative path - `URL` throws on all three, and a truncation helper that throws
 * on the input it is most needed for is worse than useless. The split is textual:
 * the first `/` after the `://`, or the first `/` at all.
 */

/** Where the path starts, or -1 when the value shows no path at all. */
function pathStart(url: string): number {
	const scheme = url.indexOf("://");
	return url.indexOf("/", scheme === -1 ? 0 : scheme + 3);
}

/**
 * `url` shortened to at most `max` characters, keeping the path tail.
 *
 * The ellipsis is one character (`…`, not three dots) so the budget spends on
 * the value rather than on the mark.
 */
export function truncateUrl(url: string, max = 48): string {
	const value = url.trim();
	if (max <= 1 || value.length <= max) return value;

	const start = pathStart(value);
	// Nothing to keep the tail of - a bare host, or a value with no path yet.
	// The head is what identifies it, so this one truncates the ordinary way.
	if (start === -1) return `${value.slice(0, max - 1)}…`;

	const tail = value.slice(start);
	// Even the path alone does not fit: keep its end, which is still the half
	// that differs between rows (`/orders/42` over `/v3/customers/…`).
	if (tail.length >= max) return `…${tail.slice(tail.length - (max - 1))}`;

	// Room for the path and some of what precedes it: spend the rest on the head,
	// from its start, so the scheme and as much host as fits stay readable.
	return `${value.slice(0, max - tail.length - 1)}…${tail}`;
}
