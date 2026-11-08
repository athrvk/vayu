/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a save surface does with a failure: the verdict a thrown error earns,
 * and the wait before trying again. One rule for every surface that retries
 * its own saves (`useSaveManager`, `VariableTableEditor`), rather than a copy
 * per surface.
 */

import { TIMING } from "@/config/timing";
import { isDiskFullError } from "@/lib/disk-full";
import { isFinalError } from "@/lib/query-client";
import type { SaveOutcome } from "@/stores/save-store";

/** The verdict on a save that threw `error`. */
export function saveFailureOutcome(error: unknown): SaveOutcome {
	if (isDiskFullError(error)) return "disk-full";
	return isFinalError(error) ? "final" : "failed";
}

/**
 * The wait before retry number `attempt` (counting from 0) of a save that keeps
 * failing: the user's auto-save delay, doubled per consecutive failure and
 * capped so the cadence settles instead of backing off forever.
 */
export function saveRetryDelayMs(autoSaveDelayMs: number, attempt: number): number {
	return Math.min(autoSaveDelayMs * 2 ** attempt, TIMING.SAVE_RETRY_MAX_DELAY_MS);
}
