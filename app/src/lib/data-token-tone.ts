/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one place a `DataTokenTone` becomes a colour.
 *
 * It lived inside `RuntimeToken` while the overlay was the only surface that
 * painted a `{{data.*}}` name. The script panel's "Referenced" chips paint the
 * same names (issue #604) and were reaching for `destructive` instead, so the
 * table moved out here rather than being copied - a hand-rolled copy of a
 * primitive does not receive the primitive's fixes, and "which colour is this
 * state" is exactly the fact the two surfaces must not disagree on.
 *
 * Its own module, not an export from `RuntimeToken.tsx`: a file that exports
 * both a component and a value cannot be hot-reloaded
 * (`react-refresh/only-export-components`) - the same reason `badgeVariants`
 * sits beside `badge.tsx` rather than in it. Not in `data-contract.ts` either,
 * which is deliberately pure logic shared with the completion providers and the
 * audit, none of which render anything.
 */

import type { DataTokenTone } from "./data-contract";

/**
 * Foreground per tone. `warning` is amber rather than destructive red on
 * purpose: an undeclared column still binds if the run's file carries it, so
 * the state reads "check this", never "nothing can ever answer this".
 */
export const DATA_TOKEN_TONE_CLASS: Record<DataTokenTone, string> = {
	muted: "text-muted-foreground",
	warning: "text-warning-text",
};
