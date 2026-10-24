/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Over the numbers of a failed run the engine could not fully record (#2895).
 *
 * The two causes read differently and the wording keeps them apart: a report
 * with no summary has no counts at all, and one reconciled after a crash has
 * the last figures the engine saved, which are a floor rather than the total.
 * `summaryMissing` is the stronger statement and wins when both are set.
 *
 * Silent for a report that recorded its summary.
 */

import { Callout } from "@/components/shared";
import type { RunReport } from "@/types";

export function UnrecordedFiguresNotice({ summary }: { summary: RunReport["summary"] }) {
	if (summary.summaryMissing) {
		return (
			<Callout severity="warning" title="Counts were not recorded">
				the run ended before the totals were saved.
			</Callout>
		);
	}
	if (summary.partial) {
		return (
			<Callout severity="warning" title="Counts are partial">
				Vayu&apos;s engine stopped before saving the final totals, so these are the last
				figures it recorded. Latency was not recorded.
			</Callout>
		);
	}
	return null;
}
