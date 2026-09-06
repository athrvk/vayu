/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "This run is not what it looks like" - what a load run did not do, above
 * the totals it would otherwise hide behind (issue #1503).
 *
 * A request sent with a `{{token}}` composition never resolved, or a step
 * whose pre-request script load mode never runs, both still let the run
 * finish and both still count as sent - a reader who only checks the error
 * rate would see a green run. Silent when the report carries no `warnings`
 * at all, which is every run before this field existed and every run that
 * genuinely had nothing to report.
 */

import { Callout } from "./Callout";
import type { RunReport } from "@/types/domain";

// Matches `LoadTestConfigDialog`'s pre-run notice for the script case, so a
// reader sees the same claim before the run and after it.
const TITLES: Record<string, string> = {
	unresolved_tokens: "Unresolved variables were sent",
	pre_request_script_skipped: "Pre-request script will not run",
};

export interface RunWarningsProps {
	warnings: RunReport["warnings"];
	className?: string;
}

export function RunWarnings({ warnings, className }: RunWarningsProps) {
	if (!warnings || warnings.length === 0) return null;

	return (
		<>
			{warnings.map((warning, index) => (
				<Callout
					key={`${warning.code}-${index}`}
					severity="warning"
					title={TITLES[warning.code] ?? "This run did not do everything it was asked"}
					className={className}
				>
					{warning.message}
				</Callout>
			))}
		</>
	);
}
