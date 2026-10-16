/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState } from "react";
import type { LoadTestConfig } from "@/types";
import type { LoadTestLimits } from "@/constants/load-test";
import { Label, Switch } from "@/components/ui";
import { NumberField } from "@/components/shared";
import { DisclosureCard } from "./DisclosureCard";

interface RecordingSectionProps {
	mode: LoadTestConfig["mode"];
	limits: LoadTestLimits;
	sampleRate: number;
	onSampleRateChange: (value: number) => void;
	slowThreshold: number;
	onSlowThresholdChange: (value: number) => void;
	/** Blank means "derive it from the target rate". */
	maxInFlight: string;
	onMaxInFlightChange: (raw: string) => void;
	saveTimingBreakdown: boolean;
	onSaveTimingBreakdownChange: (value: boolean) => void;
}

/**
 * Sampling, slow threshold, in-flight cap and timing breakdown: controls most
 * runs never touch, folded away so they do not sit between the profile and the
 * Start button.
 */
export function RecordingSection({
	mode,
	limits,
	sampleRate,
	onSampleRateChange,
	slowThreshold,
	onSlowThresholdChange,
	maxInFlight,
	onMaxInFlightChange,
	saveTimingBreakdown,
	onSaveTimingBreakdownChange,
}: RecordingSectionProps) {
	const [open, setOpen] = useState(false);

	return (
		<DisclosureCard open={open} onOpenChange={setOpen} title="Recording & limits">
			<div className="space-y-1.5">
				<Label htmlFor="lt-sample" className="text-xs">
					Success sample rate
					<span className="ml-1.5 font-normal text-muted-foreground">
						keeping {sampleRate}% of successful responses
					</span>
				</Label>
				<input
					id="lt-sample"
					type="range"
					value={sampleRate}
					onChange={(e) => onSampleRateChange(Number(e.target.value))}
					min={limits.SAMPLE_RATE_PCT.MIN}
					max={limits.SAMPLE_RATE_PCT.MAX}
					className="w-full accent-primary"
				/>
				{/*
				    The left stop is 1%, not 0%. The value is converted to the
				    engine's sampling period, and no period expresses "none" - that
				    is the Save timing breakdown toggle below, which gates storage
				    outright. Errors are never sampled either way; they are always
				    kept.
				 */}
				<div className="flex justify-between text-label text-muted-foreground">
					<span>1% - a trickle</span>
					<span>100% - everything</span>
				</div>
				<p className="text-label leading-relaxed text-muted-foreground">
					Sets which successful responses keep a stored timing trace. Post-request tests
					are sampled separately.
				</p>
			</div>

			<NumberField
				id="lt-slow"
				label="Slow request threshold"
				unit="ms"
				value={slowThreshold}
				onChange={(raw) => onSlowThresholdChange(Number(raw))}
				min={limits.SLOW_THRESHOLD_MS.MIN}
				max={limits.SLOW_THRESHOLD_MS.MAX}
				// Outlier capture has its own budget, so it neither spends
				// nor is spent by the sample rate above - but it is still
				// bounded (max_slow_results, 1000), because under
				// saturation nearly every request crosses the threshold.
				// 0 disables the capture rather than flagging everything.
				hint="Requests slower than this are flagged and saved whatever the sample rate, up to a retention limit. 0 turns the capture off."
			/>

			{mode === "constant_rps" && (
				<NumberField
					id="lt-max-inflight"
					label="Max in-flight requests"
					optional
					value={maxInFlight}
					onChange={onMaxInFlightChange}
					min={limits.MAX_IN_FLIGHT.MIN}
					max={limits.MAX_IN_FLIGHT.MAX}
					placeholder="Auto"
					hint="Hard cap on concurrent in-flight requests. Blank derives it from the target rate. Lowering it drops requests sooner under backpressure; raising it queues instead."
				/>
			)}

			<div className="flex items-start justify-between gap-3">
				<Label htmlFor="lt-timing" className="text-xs font-normal leading-snug">
					Save timing breakdown
					<span className="block text-label text-muted-foreground">
						DNS, TLS, connect and first-byte, per sampled request.
					</span>
				</Label>
				<Switch
					id="lt-timing"
					checked={saveTimingBreakdown}
					onCheckedChange={onSaveTimingBreakdownChange}
				/>
			</div>
		</DisclosureCard>
	);
}
