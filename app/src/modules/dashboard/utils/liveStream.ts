/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the live view's stream card reads off the frames of a streaming load run
 * (issue #3236).
 *
 * `stream_events` rides every frame of such a run and no frame of any other, so
 * its presence is the card's gate: not a run-config field, and not
 * `isStreaming` in the store, which only says the SSE connection is attached.
 * The time to first event rides gate frames alone, about one a second, and only
 * once a stream with a timed first event has completed; the newest frame
 * therefore usually lacks it, and a reader takes the latest frame that carries
 * it (the rule `latestScenarioProgress` follows).
 */

import type { LoadTestMetrics, StreamTimeToFirstEvent } from "@/types";

/** Whether the frame belongs to a streaming run; a measured `0` still does. */
export function isStreamFrame(frame: Pick<LoadTestMetrics, "stream_events"> | null): boolean {
	return frame?.stream_events !== undefined;
}

/** The latest time-to-first-event block in the buffer, or `undefined` before one exists. */
export function latestStreamFirstEvent(
	history: readonly LoadTestMetrics[]
): StreamTimeToFirstEvent | undefined {
	for (let i = history.length - 1; i >= 0; i--) {
		const firstEvent = history[i].stream_time_to_first_event;
		if (firstEvent !== undefined) return firstEvent;
	}
	return undefined;
}
