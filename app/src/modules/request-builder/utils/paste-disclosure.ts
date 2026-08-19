/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The curl-paste disclosure ledger, as a notice (issue #708).
 *
 * Pasting a command has always imported what it could and said nothing about
 * the rest, so `-x`, `--cert` and `--cacert` were silently eaten and the paste
 * looked complete. The structured importers gained this discipline in #666;
 * this is the one import path that never had it.
 *
 * Three rules the shape enforces:
 *
 * - **It never blocks the paste.** The import already happened and is correct
 *   as far as it goes; this only says what it could not carry.
 * - **One notice, dismissible.** A toast, not a panel that has to be cleared -
 *   the information is worth a glance and nothing more.
 * - **A pointer only where a home exists.** A flag whose intent Vayu has no
 *   answer for is still named, without an action that would go nowhere.
 */

import type { ToastOptions } from "@/stores/toast-store";
import type { DroppedFlag } from "@/services/curl/parseCurl";
import { revealSetting } from "@/modules/settings/reveal";

/** `-x routed the request through a proxy (Proxy settings)`. */
function describe(dropped: DroppedFlag): string {
	const home = dropped.pointer ? ` (${dropped.pointer.label})` : "";
	return `${dropped.flag} ${dropped.what}${home}`;
}

/**
 * The notice for what a paste dropped, or null when it dropped nothing.
 *
 * Null rather than an empty toast: the common paste carries everything, and a
 * "nothing was lost" notice on every one of them is how a disclosure surface
 * gets learned as noise and stops being read.
 *
 * `warning` rather than `info`, because a request that will now go direct when
 * the command said "through this proxy" fails later for a reason the paste is
 * responsible for - and the severity floor a user can raise must not hide that.
 */
export function droppedFlagsNotice(dropped: DroppedFlag[]): ToastOptions | null {
	if (dropped.length === 0) return null;

	// The first pointer, not one per flag: a toast has room for one action, and
	// the flags that carry a pointer nearly always share a destination (three of
	// the four homes are the same settings category).
	const destination = dropped.find((entry) => entry.pointer)?.pointer;

	return {
		title: "Imported, minus some flags",
		message: `${dropped.map(describe).join("; ")}.`,
		variant: "warning",
		...(destination
			? {
					action: {
						label: "Open settings",
						altText: `Open ${destination.label}`,
						onClick: () => revealSetting(destination.category, destination.anchor),
					},
				}
			: {}),
	};
}
