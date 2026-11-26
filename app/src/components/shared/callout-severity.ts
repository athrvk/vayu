/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Notice severity, kept out of `Callout.tsx` so it exports only a component (mixing breaks fast
 * refresh, which the linter flags). The array order is the sort order: a notice stopping the run
 * renders above one that warns, as position alone tells stacked notices apart.
 */
export const SEVERITY_ORDER = ["blocking", "warning", "info"] as const;

export type Severity = (typeof SEVERITY_ORDER)[number];
