/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which startup-recovery event the user has been told about (#922), as the epoch-ms timestamp the
 * engine stamped it with.
 *
 * The record is the engine's: a marker file beside the database, reported on `GET /health` while it
 * stands, because a record that cleared itself once read would be lost whenever the engine
 * restarted before the app polled. Showing a notice about it once is this side's job, and one
 * timestamp is the whole of it: a later recovery carries a later `at`, so it surfaces again with no
 * per-event bookkeeping.
 *
 * Persisted because "does not repeat on the next launch" is the point: session state would
 * re-announce a wipe every time the window opened against an engine already running.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/constants/storage-keys";

interface RecoveryNoticeState {
	/** `at` of the last acknowledged recovery; `null` if none has been. */
	acknowledgedAt: number | null;
	acknowledge: (at: number) => void;
}

interface PersistedRecoveryNotice {
	acknowledgedAt: number | null;
}

/**
 * Normalize a persisted payload. A non-finite value would compare `false` against every real
 * timestamp and re-show a dismissed notice, so anything but a finite number reads as "nothing
 * acknowledged", the safe direction since the notice is dismissible. Wired as both `migrate` and
 * `merge`, as `data-file-store` is: `migrate` runs only on a version change, `merge` on every
 * rehydrate.
 */
function normalizeRecoveryNotice(persisted: unknown): PersistedRecoveryNotice {
	const stored = (persisted ?? {}) as Partial<PersistedRecoveryNotice>;
	return {
		acknowledgedAt:
			typeof stored.acknowledgedAt === "number" && Number.isFinite(stored.acknowledgedAt)
				? stored.acknowledgedAt
				: null,
	};
}

export const useRecoveryNoticeStore = create<RecoveryNoticeState>()(
	persist(
		(set) => ({
			acknowledgedAt: null,
			acknowledge: (at) => set({ acknowledgedAt: at }),
		}),
		{
			name: STORAGE_KEYS.RECOVERY_NOTICE_STORE,
			version: 1,
			partialize: (state) => ({ acknowledgedAt: state.acknowledgedAt }),
			migrate: normalizeRecoveryNotice,
			merge: (persisted, current) => ({ ...current, ...normalizeRecoveryNotice(persisted) }),
		}
	)
);
