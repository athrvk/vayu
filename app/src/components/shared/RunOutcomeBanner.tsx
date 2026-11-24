/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The first thing a finished load run says: did it pass (#2130). `Completed` only says it ended,
 * and a run that blew every budget or half-errored ends as cleanly as a good one, so the dashboard
 * and the history detail open on this line, not a card a scroll away; the verdict is
 * `run-outcome.ts`'s, shared with the header glyph and the history row. Neutral for "Not judged",
 * never green: a run held to no standard has not passed. Renders nothing for `null` (a run still
 * streaming, a report not yet arrived): "Not judged" over a missing report would claim something
 * about a run nobody looked at.
 */

import { Callout, type CalloutProps } from "./Callout";
import { OUTCOME_TITLE, type RunJudgement, type RunOutcome } from "./run-outcome";

const PRESENTATION: Record<RunOutcome, Pick<CalloutProps, "severity" | "positive">> = {
	passed: { severity: "info", positive: true },
	failed: { severity: "blocking" },
	"not-judged": { severity: "info" },
};

export function RunOutcomeBanner({
	judgement,
	className,
}: {
	judgement: RunJudgement | null;
	className?: string;
}) {
	if (!judgement) return null;
	const { severity, positive } = PRESENTATION[judgement.outcome];
	return (
		<Callout
			severity={severity}
			positive={positive}
			title={OUTCOME_TITLE[judgement.outcome]}
			className={className}
		>
			{judgement.reason}
		</Callout>
	);
}
