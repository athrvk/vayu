/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { create } from "zustand";
import type { UpdateVerificationFailure } from "@/types/electron";

interface UpdateVerificationState {
	/**
	 * The downloaded installer whose build-provenance attestation did not
	 * verify (issue #2372), or null while none is known to have failed.
	 */
	failure: UpdateVerificationFailure | null;
	setFailure: (failure: UpdateVerificationFailure) => void;
	clear: () => void;
}

/**
 * Held in a store rather than in `useAppUpdate`'s state because two surfaces
 * read it and only one of them is there when the event arrives: the update
 * banner is mounted for the whole session and receives `update:verificationFailed`,
 * while Settings > Updates mounts later, when the user opens it, and a
 * per-instance hook would find nothing to show.
 */
export const useUpdateVerificationStore = create<UpdateVerificationState>((set) => ({
	failure: null,
	setFailure: (failure) => set({ failure }),
	clear: () => set({ failure: null }),
}));
