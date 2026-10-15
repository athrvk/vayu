/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The documentation links the renderer may open, by key.
 *
 * Keyed rather than URL-taking on purpose: the renderer cannot ask for an
 * arbitrary URL, so `shell:openAppLink` does not hand the web layer a general
 * "open anything" capability. Same links as the Help menu. The keys are
 * mirrored by `openAppLink`'s parameter type in `preload.ts` and
 * `src/types/electron.d.ts`, neither of which can import from here.
 */

import { DOCS_URL, ISSUES_URL, MCP_DOCS_URL, SCRIPTING_DOCS_URL } from "./constants.js";

export const APP_LINKS = {
	docs: DOCS_URL,
	scripting: SCRIPTING_DOCS_URL,
	mcp: MCP_DOCS_URL,
	issues: ISSUES_URL,
} as const;

export type AppLinkKey = keyof typeof APP_LINKS;

function isAppLinkKey(key: string): key is AppLinkKey {
	return Object.prototype.hasOwnProperty.call(APP_LINKS, key);
}

/** The URL behind a key; an unknown key throws rather than opening nothing. */
export function appLinkUrl(key: string): string {
	if (!isAppLinkKey(key)) throw new Error(`Unknown app link: ${key}`);
	return APP_LINKS[key];
}
