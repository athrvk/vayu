/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Events card: silent for a clean run with no sleeps, and otherwise the
 * one place a host sleep is stated in words (issue #1357's acceptance
 * criterion - "an Events row stating how long the host slept").
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunEvents } from "./RunEvents";
import type { Anomaly } from "@/modules/dashboard/utils/detectAnomalies";
import type { HostSleep } from "@/stores/host-sleep-store";

function anomaly(over: Partial<Anomaly> = {}): Anomaly {
	return {
		kind: "latency_spike",
		startSeconds: 5,
		endSeconds: 9,
		magnitude: 4.2,
		label: "p99 4.2x baseline for 4s",
		...over,
	};
}

function sleep(over: Partial<HostSleep> = {}): HostSleep {
	return { at: 30_000, durationMs: 90_000, startSeconds: 30, ...over };
}

describe("RunEvents", () => {
	it("renders nothing when there are neither anomalies nor sleeps", () => {
		const { container: empty } = render(<RunEvents />);
		expect(empty).toBeEmptyDOMElement();

		const { container: explicit } = render(<RunEvents anomalies={[]} sleeps={[]} />);
		expect(explicit).toBeEmptyDOMElement();

		const { container: nully } = render(<RunEvents anomalies={null} sleeps={null} />);
		expect(nully).toBeEmptyDOMElement();
	});

	it("renders a row naming how long the host slept, for sleeps alone", () => {
		render(<RunEvents sleeps={[sleep({ durationMs: 90_000 })]} />);

		expect(screen.getByText("Events")).toBeInTheDocument();
		// "90s" -> "1m 30s" through the same formatSleepDuration the chart mark uses.
		expect(screen.getByText(/slept for 1m 30s/)).toBeInTheDocument();
	});

	it("renders both anomalies and sleeps together when both are present", () => {
		render(<RunEvents anomalies={[anomaly()]} sleeps={[sleep()]} />);

		expect(screen.getByText("Host asleep")).toBeInTheDocument();
		expect(screen.getByText("Latency spike")).toBeInTheDocument();
	});

	it("gives the sleep row a -text tone token, never a bare fill", () => {
		render(<RunEvents sleeps={[sleep()]} />);

		const label = screen.getByText("Host asleep");
		expect(label.className).toMatch(/\btext-warning-text\b/);
		expect(label.className).not.toMatch(/\bbg-warning\b/);
	});
});
