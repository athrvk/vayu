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
 * A request sent with a `{{token}}` composition never resolved, a step
 * whose pre-request script load mode never runs, a per-host connection limit
 * the run had to raise, requests libcurl re-sent on a new connection, or
 * `Set-Cookie` headers its cookie engine discarded all still let the run
 * finish and still count as sent - a reader who only checks the error rate
 * would see a green run. Silent when the report carries no
 * `warnings` at all, which is every run before this field existed and every
 * run that genuinely had nothing to report.
 */

import { Callout } from "./Callout";
import type { RunReport } from "@/types/domain";

// Matches `LoadTestConfigDialog`'s pre-run notice for the script case, so a
// reader sees the same claim before the run and after it.
const TITLES: Record<string, string> = {
	unresolved_tokens: "Unresolved variables were sent",
	pre_request_script_skipped: "Pre-request script won't run",
	// The run did everything; the generic title would say it did not (#2394).
	per_host_limit_raised: "Connections per host were raised",
	// The run did not fail either; the target just saw more requests than the
	// totals count (#2799).
	connection_replayed: "Some requests were re-sent after a dropped connection",
	// The run finished; some virtual users just went on without a cookie the
	// server set (#3307).
	cookies_dropped: "Some cookies the server set were dropped",
	// The run sent everything it planned; a constant-rate run just has no
	// think time to wait out (#3541).
	think_timer_skipped_open_loop: "Think timer skipped on a constant-rate run",
	// The run completed; most of its responses were the target's rate limit
	// speaking, and the message names the option that would back off (#3782).
	rate_limited_dominant: "Most responses were rate limited",
	// The run did what it was asked, and paused where the target asked it to,
	// so its rate is the limiter's (#3782).
	retry_after_backoff: "Virtual users waited out Retry-After",
	// Same shape as the think timer: a constant-rate run sends on a schedule (#3782).
	retry_after_skipped_open_loop: "Retry-After back-off skipped on a constant-rate run",
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
