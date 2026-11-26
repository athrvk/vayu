/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one place a `DataTokenTone` becomes a colour. Two surfaces paint `{{data.*}}` names, the
 * `RuntimeToken` overlay and the script panel's "Referenced" chips (#604), and "which colour is
 * this state" is exactly the fact they must not disagree on; a hand-rolled copy of a primitive does
 * not receive the primitive's fixes.
 *
 * Its own module, not an export from `RuntimeToken.tsx`: a file that exports both a component and a
 * value cannot be hot-reloaded (`react-refresh/only-export-components`), the reason `badgeVariants`
 * sits beside `badge.tsx` rather than in it. Not in `data-contract.ts` either, which is pure logic
 * shared with the completion providers and the audit, none of which render anything.
 */

import type { DataTokenTone } from "./data-contract";

/**
 * Foreground per tone. `warning` is amber rather than destructive red on
 * purpose: an undeclared column still binds if the run's file carries it, so
 * the state reads "check this", never "nothing can ever answer this". It is
 * double-underlined too, so it stays apart from the accent where the two
 * colours sit close (#3499); the editor's `vayu-variable-token-warning` rule
 * in `index.css` paints the same.
 */
export const DATA_TOKEN_TONE_CLASS: Record<DataTokenTone, string> = {
	muted: "text-muted-foreground",
	warning: "text-warning-text underline decoration-double underline-offset-[3px]",
};
