/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { LoadTestConfig } from "@/types";
import type { LoadTestLimits } from "@/constants/load-test";
import { Label, Switch } from "@/components/ui";
import { NumberField } from "@/components/shared";
import { appliesRetryAfter } from "./profile";

interface RetryAfterFieldsProps {
	mode: LoadTestConfig["mode"];
	limits: LoadTestLimits;
	/** Prefixes both control ids, so two dialogs' controls never share one. */
	idPrefix: string;
	backoff: boolean;
	onBackoffChange: (value: boolean) => void;
	maxMs: number;
	onMaxMsChange: (value: number) => void;
}

/**
 * The Retry-After back-off switch and its cap (#3782), shared by the request and collection run
 * dialogs. Renders nothing in a mode with no "next request" to hold (`appliesRetryAfter`), so no
 * caller offers a control the engine would skip with a warning.
 */
export function RetryAfterFields({
	mode,
	limits,
	idPrefix,
	backoff,
	onBackoffChange,
	maxMs,
	onMaxMsChange,
}: RetryAfterFieldsProps) {
	if (!appliesRetryAfter(mode)) return null;

	return (
		<>
			<div className="flex items-start justify-between gap-3">
				<Label
					htmlFor={`${idPrefix}-retry-after`}
					className="text-xs font-normal leading-snug"
				>
					Wait out Retry-After
					<span className="block text-label text-muted-foreground">
						After a 429 or 503 that names a delay, that virtual user waits before its
						next request. The response still counts, nothing is retried. Off, a
						rate-limited run sends as fast as the 429s come back.
					</span>
				</Label>
				<Switch
					id={`${idPrefix}-retry-after`}
					checked={backoff}
					onCheckedChange={onBackoffChange}
				/>
			</div>

			{backoff && (
				<NumberField
					id={`${idPrefix}-retry-after-max`}
					label="Longest Retry-After wait"
					unit="ms"
					value={maxMs}
					onChange={(raw) => onMaxMsChange(Number(raw))}
					min={limits.RETRY_AFTER_MAX_MS.MIN}
					max={limits.RETRY_AFTER_MAX_MS.MAX}
					hint="A longer Retry-After is cut to this. The run then measures the rate the target's limiter allows, not what it does under the load you asked for."
				/>
			)}
		</>
	);
}
