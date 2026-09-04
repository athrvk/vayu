/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Everything `runAnnotations` puts on the shaded layer: the detected anomaly
 * windows, coloured by what went wrong, and the host sleeps the run could not
 * prevent, drawn as instants rather than bands (issue #1357). uPlot draws to a
 * canvas, so this drives the pure function directly rather than a rendered
 * chart.
 */

import { describe, it, expect } from "vitest";
import { runAnnotations } from "./annotations";
import type { Anomaly, AnomalyKind } from "../../../utils/detectAnomalies";
import { hostSleepLabel } from "../../../utils/hostSleep";
import type { HostSleep } from "@/stores/host-sleep-store";

function anomaly(kind: AnomalyKind, startSeconds: number, endSeconds: number): Anomaly {
	return { kind, startSeconds, endSeconds, magnitude: 4.2, label: `${kind} finding` };
}

function sleep(startSeconds: number, durationMs = 90_000): HostSleep {
	return { at: startSeconds * 1000, durationMs, startSeconds };
}

describe("runAnnotations", () => {
	it("colours a latency spike or throughput drop as warning, keeping its own window", () => {
		const spike = anomaly("latency_spike", 5, 12);
		const drop = anomaly("throughput_drop", 30, 40);

		const windows = runAnnotations([spike, drop], null);

		expect(windows).toEqual([
			{ startSeconds: 5, endSeconds: 12, label: spike.label, role: "warning" },
			{ startSeconds: 30, endSeconds: 40, label: drop.label, role: "warning" },
		]);
	});

	it("colours an error burst or the first 5xx as destructive, keeping its own window", () => {
		const burst = anomaly("error_burst", 8, 9);
		const first5xx = anomaly("first_5xx", 20, 20);

		const windows = runAnnotations([burst, first5xx], null);

		expect(windows).toEqual([
			{ startSeconds: 8, endSeconds: 9, label: burst.label, role: "destructive" },
			{ startSeconds: 20, endSeconds: 20, label: first5xx.label, role: "destructive" },
		]);
	});

	it("draws a host sleep as an instant at its start, never a band durationMs wide", () => {
		// Whether the engine's elapsed clock advanced through a suspend is a
		// per-platform answer, so a band drawn `durationMs` wide would be a claim
		// about the series that may be fiction (see hostSleep.ts / host-sleep-store
		// doc comments). The mark says only where the machine went down; the label
		// carries how long. That is the property this case pins: startSeconds ===
		// endSeconds, not startSeconds + durationMs / 1000.
		const s = sleep(50, 90_000);

		const [window] = runAnnotations(null, [s]);

		expect(window.startSeconds).toBe(50);
		expect(window.endSeconds).toBe(50);
		expect(window.startSeconds).toBe(window.endSeconds);
		expect(window.label).toBe(hostSleepLabel(s));
		expect(window.role).toBe("warning");
	});

	it("lists anomalies and sleeps together when both are present", () => {
		const spike = anomaly("latency_spike", 5, 12);
		const s = sleep(50);

		const windows = runAnnotations([spike], [s]);

		expect(windows).toHaveLength(2);
		expect(windows[0]).toMatchObject({ startSeconds: 5, endSeconds: 12, role: "warning" });
		expect(windows[1]).toMatchObject({ startSeconds: 50, endSeconds: 50, role: "warning" });
	});

	it("returns only the sleeps when anomalies is undefined or null", () => {
		const s = sleep(50);
		expect(runAnnotations(undefined, [s])).toHaveLength(1);
		expect(runAnnotations(null, [s])).toHaveLength(1);
	});

	it("returns only the anomalies when sleeps is undefined or null", () => {
		const spike = anomaly("latency_spike", 5, 12);
		expect(runAnnotations([spike], undefined)).toHaveLength(1);
		expect(runAnnotations([spike], null)).toHaveLength(1);
	});

	it("returns an empty list when both arguments are absent", () => {
		expect(runAnnotations(null, null)).toEqual([]);
		expect(runAnnotations(undefined, undefined)).toEqual([]);
	});
});
