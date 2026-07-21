/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Notice severity, kept out of `Callout.tsx` so that file exports only a
 * component — mixing the two breaks fast refresh, which the linter flags.
 *
 * The array order is the sort order: a notice that stops the run has to render
 * above one that merely warns. With up to four notices stacked, position is the
 * only thing distinguishing them.
 */
export const SEVERITY_ORDER = ["blocking", "warning", "info"] as const;

export type Severity = (typeof SEVERITY_ORDER)[number];
