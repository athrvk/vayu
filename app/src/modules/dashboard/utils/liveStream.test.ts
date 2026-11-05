/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A streaming run's frames all carry `stream_events`, and the time to first
 * event rides gate frames alone (issue #3236).
 *
 * Mutation-check: gate on truthiness and the measured-zero case fails; read only
 * the last frame and the non-gate-last case fails; scan from the front and the
 * newest-wins case fails.
 */

import { describe, it, expect } from "vitest";
import type { StreamTimeToFirstEvent } from "@/types";
import { isStreamFrame, latestStreamFirstEvent } from "./liveStream";
import { tick } from "./liveDistributions.testkit";

const ttfe = (p50: number): StreamTimeToFirstEvent => ({
	p50,
	p95: p50 * 3,
	p99: p50 * 4,
	max: p50 * 5,
	count: 4,
});

describe("isStreamFrame", () => {
	it("is true for a frame carrying stream_events, a measured 0 included", () => {
		expect(isStreamFrame(tick(1, { stream_events: 120 }))).toBe(true);
		expect(isStreamFrame(tick(1, { stream_events: 0 }))).toBe(true);
	});

	it("is false for an ordinary run's frame and for no frame", () => {
		expect(isStreamFrame(tick(1, { current_rps: 100 }))).toBe(false);
		expect(isStreamFrame(null)).toBe(false);
	});
});

describe("latestStreamFirstEvent", () => {
	it("returns the newest gate frame's block, past plain ticks", () => {
		const older = ttfe(10);
		const newer = ttfe(20);
		const history = [
			tick(1, { stream_time_to_first_event: older }),
			tick(2, { stream_time_to_first_event: newer }),
			tick(2.1, { stream_events: 50 }),
		];
		expect(latestStreamFirstEvent(history)).toBe(newer);
	});

	it("is undefined until a stream has delivered a timed first event", () => {
		expect(latestStreamFirstEvent([tick(1), tick(2)])).toBeUndefined();
		expect(latestStreamFirstEvent([])).toBeUndefined();
	});
});
