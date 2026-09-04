/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer half of the Dock/taskbar icon and its menu (issue #1364).
 *
 * `electron/os-icon.ts` decides whether a mark is worth painting - the window's
 * focus is main's to answer, not React's - and how each platform shows it. This
 * side decides *what happened*: a capture landed, the Inbox is on screen, a run
 * failed, these are the collections the user has been in.
 *
 * Every call here is fire-and-forget, the same discipline `run-progress.ts`
 * states for its own calls: nothing may wait on the OS to draw an icon.
 */

import type { OsIconCollection, OsIconSignal } from "@/types/electron";

type Bridge = NonNullable<Window["electronAPI"]>;

/**
 * The preload bridge, or nothing outside Electron - the same guard
 * `run-progress.ts` uses for an Electron-only method.
 */
function bridge(): Bridge | undefined {
	if (typeof window === "undefined") return undefined;
	const api = window.electronAPI;
	return api?.setOsIconSignal ? api : undefined;
}

function send(signal: OsIconSignal): void {
	const api = bridge();
	if (!api) return;
	try {
		api.setOsIconSignal(signal);
	} catch (error: unknown) {
		// The window is showing whatever it was showing; an icon that did not
		// repaint costs the user nothing they can act on.
		console.warn("[os-icon] signal could not be sent", error);
	}
}

/**
 * The last `recents` payload sent, so a rebuild that lands on the same list is
 * not resent.
 *
 * `useOsIcon` re-derives the recents list on every navigation and on every
 * collections refetch - far more often than the list a user has actually been
 * in changes - while the menu the OS paints from it is something main redraws
 * on every send. Comparing the fingerprint keeps a no-op re-derive from
 * becoming an IPC message and a repaint.
 */
let lastRecentsSent: string | null = null;

function recentsFingerprint(collections: readonly OsIconCollection[]): string {
	return JSON.stringify(collections);
}

export const osIcon = {
	/** A capture arrived. Whether it counts is main's call, not this one's. */
	captured(): void {
		send({ kind: "captured" });
	},

	/** The Inbox is on screen, so the pile of captures has been seen. */
	inboxOpened(): void {
		send({ kind: "inboxOpened" });
	},

	/** A load or collection run ended badly. */
	runFailed(): void {
		send({ kind: "runFailed" });
	},

	/** The collections the user has been in, most recent first. */
	recents(collections: OsIconCollection[]): void {
		const fingerprint = recentsFingerprint(collections);
		if (fingerprint === lastRecentsSent) return;
		lastRecentsSent = fingerprint;
		send({ kind: "recents", collections });
	},
};
