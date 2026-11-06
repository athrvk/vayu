/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { LoadTestLimits } from "@/constants/load-test";
import { NumberField } from "@/components/shared";
import type { LoadTestProfile } from "./useSavedLoadTestConfig";

interface StreamCapFieldsProps {
	profile: Pick<LoadTestProfile, "streamDuration" | "streamMaxEvents">;
	onChange: (patch: Partial<LoadTestProfile>) => void;
	limits: LoadTestLimits;
}

/**
 * The two stream caps, as grid items of a two-column field grid. Shared by
 * `ProfileFields` (a load run) and `RunCollectionDialog`, which shows them for
 * a design run too: a collection's streaming steps are bounded by the same two
 * numbers whichever executor runs them (#3235).
 *
 * They sit with the other run parameters, not under Advanced: for a streaming
 * request they are what decides when each transfer ends, which is the same
 * kind of decision Duration makes for the run. Reaching either is a
 * *completed* stream, so the hints say so - a user who read them as timeouts
 * would read the run's 0% error rate as luck.
 */
export function StreamCapFields({ profile, onChange, limits }: StreamCapFieldsProps) {
	return (
		<>
			<NumberField
				id="lt-stream-duration"
				label="Stop each stream after"
				unit="s"
				value={profile.streamDuration}
				onChange={(raw) => onChange({ streamDuration: Number(raw) })}
				min={limits.STREAM_DURATION_S.MIN}
				max={limits.STREAM_DURATION_S.MAX}
				hint="A stream that reaches this counts as completed, not as a timeout."
			/>
			<NumberField
				id="lt-stream-events"
				label="Or after this many events"
				value={profile.streamMaxEvents}
				onChange={(raw) => onChange({ streamMaxEvents: Number(raw) })}
				min={limits.STREAM_MAX_EVENTS.MIN}
				max={limits.STREAM_MAX_EVENTS.MAX}
				hint="Whichever comes first ends the stream. A stream is always bounded."
			/>
		</>
	);
}
