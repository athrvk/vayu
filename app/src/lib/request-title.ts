/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { DEFAULT_REQUEST_NAME } from "@/constants/request";
import { pathLabel } from "@/lib/path-label";

/**
 * Title for a request tab: the user-set name when there is one, otherwise the
 * request path. A blank or still-default placeholder name counts as "not set".
 *
 * Lives here rather than in `tab-descriptors.ts` because the History run tab's
 * editable copy is named by the same rule (`design-run-seed.ts`), and a pure
 * module cannot import a hook file.
 */
export function requestTabTitle(name: string, resolvedUrl: string): string {
	const trimmed = name.trim();
	if (hasOwnName(name)) return trimmed;
	return pathLabel(resolvedUrl) || trimmed;
}

/**
 * Whether a request carries a name the user set. The one rule for when a tab
 * is titled by the request's own name and when it falls back to its URL, so
 * the tab descriptor's `fromUrl` cannot disagree with the title it describes.
 */
export function hasOwnName(name: string): boolean {
	const trimmed = name.trim();
	return trimmed !== "" && trimmed !== DEFAULT_REQUEST_NAME;
}
