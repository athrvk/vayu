/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { LoadTestLimits } from "@/constants/load-test";
import {
	CONCURRENCY_LABEL,
	CONCURRENCY_UNIT,
	loadTestModeLabel,
} from "@/constants/load-test-modes";
import { NumberField } from "@/components/shared";
import { usesDuration } from "./profile";
import type { LoadTestProfile } from "./useSavedLoadTestConfig";

interface ProfileFieldsProps {
	profile: LoadTestProfile;
	onChange: (patch: Partial<LoadTestProfile>) => void;
	limits: LoadTestLimits;
	/** True when the request streams: the two stream caps are shown. */
	isStreamingRequest: boolean;
	/**
	 * The label of the Fixed request count mode's count. "Requests" for a single request; a
	 * collection run counts passes through its sequence, where a request count
	 * would understate the load by the sequence's length.
	 */
	iterationsLabel?: string;
}

type NumericProfileKey = Exclude<keyof LoadTestProfile, "mode">;

/** Only the fields the chosen profile actually uses. */
export function ProfileFields({
	profile,
	onChange,
	limits,
	isStreamingRequest,
	iterationsLabel = "Requests",
}: ProfileFieldsProps) {
	const { mode } = profile;
	const set = (key: NumericProfileKey) => (raw: string) => onChange({ [key]: Number(raw) });

	return (
		<div className="grid grid-cols-2 gap-3">
			{mode === "constant_rps" && (
				<NumberField
					id="lt-rps"
					label="Target rate"
					unit="req/s"
					value={profile.rps}
					onChange={set("rps")}
					min={limits.RPS.MIN}
					max={limits.RPS.MAX}
				/>
			)}

			{mode !== "constant_rps" && (
				<NumberField
					id="lt-concurrency"
					label={
						mode === "ramp_up"
							? `Target ${CONCURRENCY_UNIT}`
							: mode === "capacity"
								? `Maximum ${CONCURRENCY_UNIT}`
								: CONCURRENCY_LABEL
					}
					value={profile.concurrency}
					onChange={set("concurrency")}
					min={limits.CONCURRENCY.MIN}
					max={limits.CONCURRENCY.MAX}
					hint={
						mode === "capacity"
							? "The ceiling the search will not climb past. Reaching it ends the run."
							: undefined
					}
				/>
			)}

			{mode === "iterations" && (
				<NumberField
					id="lt-iterations"
					label={iterationsLabel}
					value={profile.iterations}
					onChange={set("iterations")}
					min={limits.ITERATIONS.MIN}
					max={limits.ITERATIONS.MAX}
				/>
			)}

			{usesDuration(mode) && (
				<NumberField
					id="lt-duration"
					label={
						mode === "ramp_up"
							? "Total duration"
							: mode === "capacity"
								? "Give up after"
								: "Duration"
					}
					unit="s"
					value={profile.duration}
					onChange={set("duration")}
					min={limits.DURATION_S.MIN}
					max={limits.DURATION_S.MAX}
				/>
			)}

			{mode === "capacity" && (
				<NumberField
					id="lt-slo"
					label="Latency budget"
					unit="ms"
					value={profile.sloMs}
					onChange={set("sloMs")}
					min={limits.SLO_MS.MIN}
					max={limits.SLO_MS.MAX}
					hint="The p99 the search looks for the edge of. Prefilled from your p99 threshold setting."
				/>
			)}

			{mode === "capacity" && (
				<NumberField
					id="lt-step-duration"
					label="Hold each level for"
					unit="s"
					value={profile.stepDuration}
					onChange={set("stepDuration")}
					min={limits.STEP_DURATION_S.MIN}
					max={limits.STEP_DURATION_S.MAX}
					hint="Longer steps measure each level more steadily; shorter ones search faster."
				/>
			)}

			{(mode === "ramp_up" || mode === "capacity") && (
				<NumberField
					id="lt-start-concurrency"
					label="Start from"
					value={profile.startConcurrency}
					onChange={set("startConcurrency")}
					min={limits.START_CONCURRENCY.MIN}
					max={limits.START_CONCURRENCY.MAX}
					hint={
						mode === "capacity"
							? "The first level the search measures. It steps up from here while latency holds."
							: `${CONCURRENCY_LABEL} at the start of the ramp. Vayu climbs from here to the target.`
					}
				/>
			)}

			{mode === "ramp_up" && (
				<NumberField
					id="lt-ramp"
					label="Ramp duration"
					unit="s"
					value={profile.rampDuration}
					onChange={set("rampDuration")}
					min={limits.RAMP_DURATION_S.MIN}
					max={limits.RAMP_DURATION_S.MAX}
					hint={`One climb up, then hold. ${
						profile.duration === profile.rampDuration
							? "The total duration equals the ramp, so there is no hold at the target. "
							: ""
					}For a staircase or a limit search use ${loadTestModeLabel("capacity")}.`}
				/>
			)}

			{/*
			 * The stream caps sit with the other run parameters, not under
			 * Advanced: for a streaming request they are what decides when each
			 * transfer ends, which is the same kind of decision Duration makes for
			 * the run. Reaching either is a *completed* stream, so the hints say so
			 * - a user who read them as timeouts would read the run's 0% error rate
			 * as luck.
			 */}
			{isStreamingRequest && (
				<>
					<NumberField
						id="lt-stream-duration"
						label="Stop each stream after"
						unit="s"
						value={profile.streamDuration}
						onChange={set("streamDuration")}
						min={limits.STREAM_DURATION_S.MIN}
						max={limits.STREAM_DURATION_S.MAX}
						hint="A stream that reaches this counts as completed, not as a timeout."
					/>
					<NumberField
						id="lt-stream-events"
						label="Or after this many events"
						value={profile.streamMaxEvents}
						onChange={set("streamMaxEvents")}
						min={limits.STREAM_MAX_EVENTS.MIN}
						max={limits.STREAM_MAX_EVENTS.MAX}
						hint="Whichever comes first ends the stream. Under load a stream is always bounded."
					/>
				</>
			)}
		</div>
	);
}
