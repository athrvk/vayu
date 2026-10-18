/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Number formatting for the dashboard cards. Separate from `shared.tsx`, which
 * re-exports components: a module holding both cannot be hot-reloaded.
 */

import { formatRate } from "@/lib/format-number";

/**
 * A possibly-missing number through one of the shared formatters. A missing
 * value draws "-" here because the formatters print it as "0", a measured zero.
 */
export function orDash(v: number | undefined, format: (n: number) => string): string {
	return v !== undefined ? format(v) : "-";
}

/** A per-second rate through `formatRate` (grouped, locale-aware); "-" when missing. */
export function fmtRate(v: number | undefined): string {
	return orDash(v, formatRate);
}
