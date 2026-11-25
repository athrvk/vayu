/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Extract a short display path from a request URL. URLs may contain {{variables}} or be malformed
 * mid-edit, so this never throws. Lives here rather than in `tab-descriptors.ts` because the agent
 * reference lines (`agent-reference.ts`) name a run by the same path, and a pure module cannot
 * import a hook file.
 */
export function pathLabel(url: string): string {
	if (!url) return "";
	try {
		return safeDecode(new URL(url).pathname) || "/";
	} catch {
		// Strip scheme+host if present, otherwise show the raw string
		// A title is drawn, tooltipped and copied: the query and fragment never
		// belong in a path label, whatever token the host is (#3686).
		const stripped = url.replace(/^[a-z]+:\/\/[^/]*/i, "").replace(/[?#].*$/s, "");
		const whole = url.replace(/[?#].*$/s, "");
		return safeDecode(stripped) || safeDecode(whole);
	}
}

/** A literal `%` mid-edit (`/sale/50%`) is a malformed escape; keep the text as typed. */
function safeDecode(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}
