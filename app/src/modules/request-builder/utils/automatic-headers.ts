/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Settings tab's "Don't send automatic headers" list (issue #1765): which
 * names it offers, and which stored names it can only show.
 *
 * The list is **stored** on the request as `disabledSystemHeaders` (Postman's
 * own key, lowercased names). It is a different thing from the Headers tab's
 * per-send `disabledDefaultHeaders` (#1229), which is never saved; the engine
 * unions the two at send time, which is why the Headers tab shows a name
 * stored here as off rather than offering a tick that could not turn it back
 * on.
 */

import type { RequestDefaultHeader } from "@/types";

/** One checkbox in the list. `key` is the stored (lowercased) name. */
export interface AutomaticHeaderOption {
	key: string;
	/** The header as the wire spells it. */
	name: string;
	/** What the engine would send under it, in a few words. */
	detail: string;
}

/**
 * The headers a Vayu send can carry without the user writing them, and which
 * the engine can leave out. `User-Agent` and `Accept-Encoding` are also
 * declared over `GET /request-defaults`, and their declared value replaces the
 * detail here; `Accept` (libcurl's `*\/*`) and `Content-Type` (implied by the
 * body mode) are added below the declared set, so nothing declares them.
 */
const BUILT_IN: readonly AutomaticHeaderOption[] = [
	{ key: "user-agent", name: "User-Agent", detail: "Vayu's own" },
	{ key: "accept", name: "Accept", detail: "*/*" },
	{ key: "accept-encoding", name: "Accept-Encoding", detail: "the encodings Vayu decompresses" },
	{
		key: "content-type",
		name: "Content-Type",
		detail: "implied by the body mode; multipart keeps its boundary",
	},
];

/**
 * Postman's system headers that Vayu stores for the export and does not apply,
 * and why: `never-sent` ones no Vayu send carries anyway, and `cannot-omit`
 * ones HTTP/1.1 framing needs, so the engine sends them whatever is stored.
 */
export const KEPT_NOT_APPLIED: Readonly<Record<string, "never-sent" | "cannot-omit">> = {
	"postman-token": "never-sent",
	connection: "never-sent",
	"cache-control": "never-sent",
	host: "cannot-omit",
	"content-length": "cannot-omit",
};

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
	"postman-token": "Postman-Token",
	connection: "Connection",
	"cache-control": "Cache-Control",
	host: "Host",
	"content-length": "Content-Length",
};

/** The wire spelling of a stored name Vayu keeps without applying. */
export function displayHeaderName(key: string): string {
	return DISPLAY_NAMES[key] ?? key;
}

/**
 * The checkboxes, in order: the built-in four, then every other header the
 * engine declares (the correlation id, when it is on), then any other stored
 * name - so a name stored while its default was switched off in engine config
 * can still be unticked, rather than sitting on the request out of reach.
 */
export function automaticHeaderOptions(
	declared: readonly RequestDefaultHeader[],
	stored: readonly string[]
): AutomaticHeaderOption[] {
	const byKey = new Map(declared.map((header) => [header.name.toLowerCase(), header]));
	const detailOf = (header: RequestDefaultHeader) =>
		header.generated ? "generated per request" : (header.value ?? "");

	const options: AutomaticHeaderOption[] = BUILT_IN.map((option) => {
		const header = byKey.get(option.key);
		return header ? { ...option, detail: detailOf(header) } : option;
	});
	const seen = new Set(options.map((option) => option.key));

	for (const header of declared) {
		const key = header.name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		options.push({ key, name: header.name, detail: detailOf(header) });
	}
	for (const key of stored) {
		if (seen.has(key) || key in KEPT_NOT_APPLIED) continue;
		seen.add(key);
		options.push({ key, name: key, detail: "not added by this engine right now" });
	}
	return options;
}

/** The stored names the tab shows read-only, grouped by why they do nothing. */
export function unappliedStoredHeaders(stored: readonly string[]): {
	neverSent: string[];
	cannotOmit: string[];
} {
	return {
		neverSent: stored.filter((key) => KEPT_NOT_APPLIED[key] === "never-sent"),
		cannotOmit: stored.filter((key) => KEPT_NOT_APPLIED[key] === "cannot-omit"),
	};
}

/**
 * True when the request's stored list leaves `name` out - compared without
 * case, because the engine declares `User-Agent` and stores `user-agent`.
 */
export function isStoredOff(stored: readonly string[], name: string): boolean {
	return stored.includes(name.toLowerCase());
}
