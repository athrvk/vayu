/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Read the dashboard's live-run config back out of a run's stored snapshot
 * (issue #1935).
 *
 * A run the app starts hands the dashboard its own arguments. A run an MCP
 * agent starts has none to hand over, so the only record of what it asked for
 * is the `configSnapshot` the engine stored with the row. The snapshot is the
 * request body as sent, so a key can be absent, and the engine accepts a bare
 * number for a duration where the app always sends a string - the dashboard's
 * duration parsing reads a string.
 */

import type { LoadTestRequestInfo, LoadTestRunConfig } from "@/stores/dashboard-store";
import type { RunConfigSnapshot } from "@/types";

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A duration string as sent, or a bare number of seconds as `"<n>s"`. */
function duration(value: unknown): string | undefined {
	const n = count(value);
	return n === undefined ? text(value) : `${n}s`;
}

/**
 * Only the keys the dashboard reads, and only the ones present: an absent key
 * stays absent rather than becoming `undefined`, so the result compares equal
 * to the config the app would have built for the same run.
 */
export function loadConfigFromSnapshot(snapshot: RunConfigSnapshot): LoadTestRunConfig {
	const fields: LoadTestRunConfig = {
		mode: text(snapshot.mode),
		duration: duration(snapshot.duration),
		// The engine's own key for the rate is `rps`; `targetRps` is the name
		// its report renames it to (`runs.cpp`) and the app's request body uses.
		targetRps: count(snapshot.targetRps) ?? count(snapshot.rps),
		concurrency: count(snapshot.concurrency),
		iterations: count(snapshot.iterations),
		comment: text(snapshot.comment),
		rampUpDuration: duration(snapshot.rampUpDuration),
		startConcurrency: count(snapshot.startConcurrency),
	};
	return Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== undefined)
	) as LoadTestRunConfig;
}

/** The method and URL, or `null` unless both were recorded. */
export function requestInfoFromSnapshot(snapshot: RunConfigSnapshot): LoadTestRequestInfo | null {
	const method = text(snapshot.method);
	const url = text(snapshot.url);
	return method !== undefined && url !== undefined ? { method, url } : null;
}
