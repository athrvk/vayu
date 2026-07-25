/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Toast queue limits.
 *
 * The timings live in `config/timing.ts` (`TOAST_DURATION_MS`, `TOAST_EXIT_MS`),
 * which is where every UI-facing delay in the app is kept. This file holds what
 * is not a delay.
 */

/**
 * How many toasts may stack at once. Four is what fits above the fold at the
 * viewport's width without the oldest sliding off the top of the screen.
 *
 * Past that the oldest is dropped. A burst of failures used to stack unbounded,
 * and the ones pushed off-screen were both unreachable and undismissable.
 */
export const MAX_TOASTS = 4;
