/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where a load run is aimed, read off the request's variable-resolved URL
 * (#2117). One classification feeds both the dialog's target line and the
 * advisory notice, so the two cannot disagree about which host they mean.
 */

import { VARIABLE_PATTERN } from "@/constants/variables";
import { isLocalHost } from "@/lib/host-locality";

export type Target =
	| { kind: "host"; host: string; isLocal: boolean }
	/** The URL names no host the app can read; `variable` is the first unresolved token in it. */
	| { kind: "unknown"; variable: string | null };

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The part of `url` between the scheme and the first `/`, `?` or `#`, without
 * any `user:pass@`. Cut textually because a `{{token}}` in it makes `new URL`
 * throw, and the token is the thing worth naming.
 */
function authorityOf(url: string): string {
	const rest = url.replace(SCHEME, "");
	const authority = rest.split(/[/?#]/, 1)[0];
	return authority.slice(authority.lastIndexOf("@") + 1);
}

/**
 * A URL typed without a scheme is sent as http, so it is read as http here
 * rather than as the `localhost:` "scheme" `new URL("localhost:3000/x")` finds.
 */
function hostnameOf(url: string): string | null {
	try {
		const hostname = new URL(SCHEME.test(url) ? url : `http://${url}`).hostname;
		return hostname === "" ? null : hostname;
	} catch {
		return null;
	}
}

/**
 * A token in the path or query leaves the host readable, so only the authority
 * is searched: `https://api.example.com/users/{{id}}` is still a known host.
 */
export function classifyTarget(resolvedUrl: string): Target {
	const url = resolvedUrl.trim();
	const [unresolved] = authorityOf(url).matchAll(VARIABLE_PATTERN);
	if (unresolved) return { kind: "unknown", variable: unresolved[1].trim() };

	const host = hostnameOf(url);
	if (host === null) return { kind: "unknown", variable: null };
	return { kind: "host", host, isLocal: isLocalHost(host) };
}
