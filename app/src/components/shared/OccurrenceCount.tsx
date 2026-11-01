/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatNumber } from "@/lib/format-number";

/**
 * `x3` beside a line that a load run saw more than once: a failure under Test
 * validation, or an entry of a script's message or console sample (#3127).
 * Renders nothing for one occurrence or an absent count, which means once.
 */
export function OccurrenceCount({ count }: { count: number | undefined }) {
	if (count === undefined || count <= 1) return null;
	return <span className="shrink-0 font-mono tabular-nums">x{formatNumber(count)}</span>;
}
