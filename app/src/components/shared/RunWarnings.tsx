/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "This run is not what it looks like": what a load run did not do, above the totals it would hide
 * behind (#1503). A `{{token}}` composition never resolved, a step whose pre-request script load
 * mode never runs, a per-host connection limit the run had to raise, requests libcurl re-sent on a
 * new connection, `Set-Cookie` headers its cookie engine discarded: all let the run finish and
 * count as sent, so a reader checking only the error rate sees a green run. Silent when the report
 * has no `warnings` (runs older than the field, and runs with nothing to report).
 */

import { Callout } from "./Callout";
import type { RunReport } from "@/types/domain";

// The script case matches `LoadTestConfigDialog`'s pre-run notice, so the claim reads the same
// before and after the run.
const TITLES: Record<string, string> = {
	unresolved_tokens: "Unresolved variables were sent",
	pre_request_script_skipped: "Pre-request script won't run",
	// The run did everything; the generic title would say it did not (#2394).
	per_host_limit_raised: "Connections per host were raised",
	// Not a failure either: the target saw more requests than the totals count (#2799).
	connection_replayed: "Some requests were re-sent after a dropped connection",
	// The run finished; some virtual users went on without a cookie the server set (#3307).
	cookies_dropped: "Some cookies the server set were dropped",
	// Everything planned was sent; a constant-rate run has no think time to wait out (#3541).
	think_timer_skipped_open_loop: "Think timer skipped on a constant-rate run",
	// Completed, but most responses were the target's rate limit, and the message names the option
	// that backs off (#3782).
	rate_limited_dominant: "Most responses were rate limited",
	// The run did what was asked, pausing where the target asked, so its rate is the limiter's
	// (#3782).
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
