/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Set-Cookie parsing for the Cookies tab, in its own module: a component file exporting a function
 * breaks fast refresh (`react-refresh/only-export-components`), and the parser is worth testing
 * without rendering. Three silent corruptions it avoids:
 *
 *   - splitting on `,` cuts `Expires=Wed, 21 Oct 2015 07:28:00 GMT` in half, producing a phantom
 *     cookie named "21 Oct 2015 07:28:00 GMT" and losing the real one's attributes;
 *   - `pair.split("=")` drops everything past the second `=`, and session cookies are routinely
 *     base64 with `=` padding, so the shown value differs from the server's;
 *   - `attrs` must be rendered, not only parsed.
 */

export interface ParsedCookie {
	name: string;
	value: string;
	attrs: string[];
}

/**
 * One received `Set-Cookie` line: one cookie, attributes after the first `;`. No comma split: a
 * line is one cookie, so a comma in the value or `Expires=` belongs to it (`prefs=a=1, theme=dark`
 * is one cookie). Null for a line with no displayable name.
 */
export function parseSetCookieLine(line: string): ParsedCookie | null {
	const [pair, ...rest] = line.split(";");
	const at = pair.indexOf("=");
	// `at === 0` is an unnamed cookie; neither that nor `-1` is displayable.
	if (at <= 0) return null;
	return {
		name: pair.slice(0, at).trim(),
		// slice, not split: the value may legally contain "=".
		value: pair.slice(at + 1).trim(),
		attrs: rest.map((a) => a.trim()).filter(Boolean),
	};
}

/**
 * Where one cookie ends in a folded header: Set-Cookie headers arrive joined by ", ", and a new
 * cookie starts only where a comma precedes `name=`, which a date's remainder never matches, so
 * expiry commas survive.
 */
const COOKIE_BOUNDARY = /,\s*(?=[^;,\s=]+=)/;

/**
 * Cookies out of the engine's folded `set-cookie` entry. **Legacy only (#2460)**: the Cookies tab
 * parses received lines with `parseSetCookieLine`; this guesses boundaries from joined text and is
 * wrong for `prefs=a=1, theme=dark`. It serves what has no lines: a response stored before the
 * engine kept them, a stream's `open` frame, an engine predating the key.
 */
export function parseSetCookie(header: string): ParsedCookie[] {
	return header
		.split(COOKIE_BOUNDARY)
		.map(parseSetCookieLine)
		.filter((c): c is ParsedCookie => c !== null);
}
