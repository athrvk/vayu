/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Host matching for the cookie section - the approximate half, kept honest.
 *
 * libcurl decides what is actually attached, applying the full
 * domain/path/secure/expiry rules at transfer time. These two functions answer
 * a deliberately weaker question - "is this cookie held for this host?" - so
 * the section can list something useful without claiming to be the matcher.
 * Re-implementing curl's rules here would be a second matcher to keep in step
 * with a C library, and wrong in exactly the cases someone opens this section
 * to debug.
 */

import type { EngineCookie } from "@/types";

/**
 * The host a URL will be sent to, or null when it is not a URL yet.
 *
 * A request being edited holds half-typed and unresolved URLs constantly, so a
 * parse failure is the ordinary case and returns null rather than throwing.
 */
export function hostOf(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase() || null;
	} catch {
		return null;
	}
}

/**
 * Host-level match only - see the file comment. A jar domain may be stored with
 * a leading dot (the "and its subdomains" form) or without it; the dotted
 * comparison is what keeps `notexample.com` from matching `api.example.com`,
 * which a bare `endsWith` accepts.
 */
export function cookieMatchesHost(cookie: EngineCookie, host: string): boolean {
	const domain = cookie.domain.toLowerCase().replace(/^\./, "");
	return host === domain || host.endsWith(`.${domain}`);
}
