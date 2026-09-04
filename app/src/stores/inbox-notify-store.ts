/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which inboxes may interrupt the user on a capture (issue #1388).
 *
 * #1358 classified every event the app raises into the ones worth an OS
 * notification and the ones the toast answers on its own. A capture is the one
 * relevant event with no natural rate: a run ends once, an update lands once, a
 * webhook source delivers hundreds a minute. So it is not another entry in the
 * shared list - it is off even when system notifications are on, and turned on
 * for one inbox at a time, by that inbox's own control.
 *
 * The preference lives beside the engine's record rather than inside it, as
 * `host-sleep-store` keeps a run's annotation beside a report that has no field
 * for it. The engine's inbox is in-memory state that never outlives the process
 * that opened it (`db/database.cpp`: captures are cleared at startup because
 * "no inbox survives the process that opened it"), and it does not act on this
 * flag - only the desktop app does. Storing it there would put a client
 * preference in an API MCP clients and the CLI also read.
 *
 * An id is therefore dead once the engine that minted it exits, which is why
 * {@link retainInboxes} prunes against a list read the engine answered: without
 * it a persisted map would grow one entry per inbox ever started and never
 * shrink.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/constants/storage-keys";

interface InboxNotifyState {
	/**
	 * The inboxes whose captures may notify. Off is absence rather than
	 * `false`: the default is off, and a map that only holds the exceptions
	 * cannot disagree with itself about what an unknown inbox does.
	 */
	enabled: Record<string, true>;
	setEnabled: (inboxId: string, on: boolean) => void;
	/** Drop every inbox not in @p inboxIds - the engine's list is the truth. */
	retainInboxes: (inboxIds: readonly string[]) => void;
}

/** Normalize a persisted payload: only string keys that are actually on. */
function normalizeEnabled(persisted: unknown): { enabled: Record<string, true> } {
	const stored = (persisted ?? {}) as { enabled?: unknown };
	const raw = stored.enabled;
	if (!raw || typeof raw !== "object") return { enabled: {} };

	const enabled: Record<string, true> = {};
	for (const [inboxId, on] of Object.entries(raw as Record<string, unknown>)) {
		// A hand-edited entry must not put a truthy string where a reader asks
		// a boolean question, and an entry that is off is simply absent.
		if (inboxId.length > 0 && on === true) enabled[inboxId] = true;
	}
	return { enabled };
}

export const useInboxNotifyStore = create<InboxNotifyState>()(
	persist(
		(set) => ({
			enabled: {},

			setEnabled: (inboxId, on) =>
				set((state) => {
					if (!on) {
						if (!(inboxId in state.enabled)) return state;
						const enabled = { ...state.enabled };
						delete enabled[inboxId];
						return { enabled };
					}
					if (state.enabled[inboxId] === true) return state;
					return { enabled: { ...state.enabled, [inboxId]: true } };
				}),

			retainInboxes: (inboxIds) =>
				set((state) => {
					const live = new Set(inboxIds);
					const kept = Object.keys(state.enabled).filter((id) => live.has(id));
					if (kept.length === Object.keys(state.enabled).length) return state;
					const enabled: Record<string, true> = {};
					for (const id of kept) enabled[id] = true;
					return { enabled };
				}),
		}),
		{
			name: STORAGE_KEYS.INBOX_NOTIFY_STORE,
			version: 1,
			partialize: (state) => ({ enabled: state.enabled }),
			// Both, as `host-sleep-store` wires them: `migrate` runs on a version
			// change, `merge` on every rehydrate, and a malformed entry must not
			// reach the reader either way.
			migrate: normalizeEnabled,
			merge: (persisted, current) => ({ ...current, ...normalizeEnabled(persisted) }),
		}
	)
);

/**
 * May @p inboxId's captures notify? The gate the call site reads.
 *
 * Read rather than subscribed at the capture site - `systemNotify.post` reads
 * the global opt-in the same way, and for the same reason: it only has to be
 * right at the moment the capture arrives.
 */
export function inboxNotifiesOnCapture(inboxId: string | null | undefined): boolean {
	if (!inboxId) return false;
	return useInboxNotifyStore.getState().enabled[inboxId] === true;
}
