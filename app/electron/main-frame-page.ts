/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Whether a `did-start-navigation` replaces the page the renderer is mounted
 * in. Only that navigation can be followed by the main frame's
 * `did-finish-load` (which calls `ready`); a subframe (the response preview's
 * sandboxed `srcDoc` iframe) or a same-document change (a hash or pushState
 * route) never is, so holding intents for one would never release them.
 *
 * `did-start-loading` cannot tell these apart - it fires for a subframe too -
 * so every listener that means "the page is going away" subscribes to
 * `did-start-navigation` and asks this (#3339, #3377).
 */
export function startsMainFramePage(details: {
	readonly isMainFrame: boolean;
	readonly isSameDocument: boolean;
}): boolean {
	return details.isMainFrame && !details.isSameDocument;
}
