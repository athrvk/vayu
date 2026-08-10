/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one line a run report says about keeping its OAuth 2.0 credential alive.
 *
 * Pure, so the wording is unit-testable without rendering the whole detail
 * pane, and so the component file keeps exporting only a component.
 */

import { formatDuration } from "@/modules/dashboard/utils/format";
import type { RunReport } from "@/types";

export interface AuthRefreshNote {
	text: string;
	/** A failed refresh is what leaves 401s unexplained - say it louder. */
	warning: boolean;
}

/**
 * Describe a run's mid-run token refreshes, or `null` when there is nothing to
 * say: a run that could not refresh at all reports no section (see
 * `RunReport.auth`), and a run that was watched and never needed a refresh has
 * a section with nothing in it.
 */
export function authRefreshNote(auth: RunReport["auth"]): AuthRefreshNote | null {
	if (!auth) return null;

	const at = auth.refreshes.map((r) => formatDuration(Math.round(r.atSeconds * 1000)));
	const failures = auth.refreshFailures;
	if (at.length === 0 && failures === 0) return null;

	const parts: string[] = [];
	if (at.length === 1) {
		parts.push(`Access token refreshed at ${at[0]}`);
	} else if (at.length > 1) {
		parts.push(`Access token refreshed ${at.length} times (${at.join(", ")})`);
	}
	if (failures > 0) {
		parts.push(
			`${failures} refresh ${failures === 1 ? "failure" : "failures"}` +
				(auth.lastError ? ` - ${auth.lastError}` : "")
		);
	}
	return { text: parts.join("; "), warning: failures > 0 };
}
