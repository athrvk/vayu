/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer half of the system notifications (issue #1358).
 *
 * `electron/notify.ts` decides whether a notification can and should be shown -
 * the window's focus, the platform's support. This side decides what is worth
 * saying, and reads the one thing main cannot: the opt-in, which lives in a
 * localStorage-backed store the main process has no access to.
 *
 * The rule for what belongs here is in the issue, and it is about *when* the
 * user learns something, not how important it is. An event qualifies when it is
 * asynchronous, terminal, and may land while the user is in another
 * application: a run finishing, the engine dropping out, an update becoming
 * ready, a sign-in completing in the system browser. Everything else - copied,
 * saved, moved, switched - is immediate feedback for something the user just
 * did in a focused window, and the toast is the whole of it.
 *
 * `post` is fire-and-forget by design: no call site may await the OS to get on
 * with ending a run. Every event that posts one also raises its toast, so a
 * build that cannot notify (see `notify.ts` on what macOS authorizes) still
 * tells the user everything - just only where they can already see it.
 */

import { useClientSettingsStore } from "@/stores";
import type { SystemNotificationAvailability, SystemNotificationTarget } from "@/types/electron";

/** The events relevant enough to interrupt another application. */
export const NOTIFY_KINDS = {
	loadRunFinished: "load-run-finished",
	loadRunStopped: "load-run-stopped",
	loadRunFailed: "load-run-failed",
	collectionRunFinished: "collection-run-finished",
	collectionRunFailed: "collection-run-failed",
	engineLost: "engine-lost",
	engineRestartFailed: "engine-restart-failed",
	updateReady: "update-ready",
	signedIn: "signed-in",
} as const;

export type NotifyKind = (typeof NOTIFY_KINDS)[keyof typeof NOTIFY_KINDS];

export interface NotifyRequest {
	kind: NotifyKind;
	title: string;
	body: string;
	/** Where a click lands. Omitted means "just bring the window back". */
	target?: SystemNotificationTarget;
}

type Bridge = NonNullable<Window["electronAPI"]>;

/**
 * The preload bridge, or nothing outside Electron - the same guard the rest of
 * the renderer uses for an Electron-only method.
 */
function bridge(): Bridge | undefined {
	if (typeof window === "undefined") return undefined;
	const api = window.electronAPI;
	return api?.showNotification ? api : undefined;
}

export const systemNotify = {
	/**
	 * Tell the user something happened, if they asked to hear about it while
	 * they are elsewhere.
	 *
	 * The preference is read here rather than watched: it only has to be right
	 * at the moment the event happens, and every caller is a service, a query
	 * callback or an event handler with no hook to hang a subscription on -
	 * the same reason `showToast` reads its own settings this way.
	 */
	post(request: NotifyRequest): void {
		const api = bridge();
		if (!api) return;
		if (!useClientSettingsStore.getState().systemNotifications) return;

		void api
			.showNotification({
				kind: request.kind,
				title: request.title,
				body: request.body,
				target: request.target ?? { view: "app" },
			})
			.catch((error: unknown) => {
				// The toast for this event has already been raised, so a failure
				// here costs the user nothing they can act on. Logged, never thrown
				// at the run that was ending.
				console.warn(`[notify] "${request.kind}" could not be posted`, error);
			});
	},

	/**
	 * Can this build show one at all? `null` outside Electron, where the
	 * question does not arise.
	 */
	async availability(): Promise<SystemNotificationAvailability | null> {
		const api = bridge();
		if (!api?.notificationAvailability) return null;
		try {
			return await api.notificationAvailability();
		} catch (error: unknown) {
			console.warn("[notify] availability could not be read", error);
			return null;
		}
	},
};
