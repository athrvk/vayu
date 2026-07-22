/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Set-Cookie parsing for the response Cookies tab.
 *
 * Its own module rather than an export from `ResponseCookies.tsx`: a component
 * file that also exports a function breaks Vite's fast refresh for that file
 * (`react-refresh/only-export-components`), and the parser is worth testing
 * without rendering anything.
 *
 * What this replaces was labelled "simplified" and corrupted three things
 * silently - it displayed wrong data, not merely less data:
 *
 *   - `split(",")` cut `Expires=Wed, 21 Oct 2015 07:28:00 GMT` in half, so a
 *     cookie with an expiry produced a phantom row named
 *     "21 Oct 2015 07:28:00 GMT" and lost the real one's attributes.
 *   - `const [name, value] = pair.split("=")` drops everything past the second
 *     `=`. Session cookies are routinely base64, which ends in `=` padding, so
 *     the value on screen was not the value the server set.
 *   - `attrs` was parsed on every row and rendered nowhere.
 */

export interface ParsedCookie {
	name: string;
	value: string;
	attrs: string[];
}

/**
 * Where one cookie ends and the next begins.
 *
 * Multiple Set-Cookie headers arrive joined by ", ". A new cookie only starts
 * where a comma is followed by `name=`; the remainder of a date
 * ("21 Oct 2015 07:28:00 GMT") never matches that, so expiry commas survive.
 */
const COOKIE_BOUNDARY = /,\s*(?=[^;,\s=]+=)/;

export function parseSetCookie(header: string): ParsedCookie[] {
	return header
		.split(COOKIE_BOUNDARY)
		.map((chunk): ParsedCookie | null => {
			const [pair, ...rest] = chunk.split(";");
			const at = pair.indexOf("=");
			// `at === 0` is an unnamed cookie; neither that nor `-1` is displayable.
			if (at <= 0) return null;
			return {
				name: pair.slice(0, at).trim(),
				// slice, not split - the value may legally contain "=".
				value: pair.slice(at + 1).trim(),
				attrs: rest.map((a) => a.trim()).filter(Boolean),
			};
		})
		.filter((c): c is ParsedCookie => c !== null);
}
