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
 * The live-dot overlay (UPlotChart.tsx) pulses via a CSS animation. A CSS
 * keyframe name is case-sensitive, so a class that names a keyframe nothing
 * defines renders a static dot - the animation silently no-ops. This test
 * guards both ends: the class the rendered dot actually carries, and that the
 * keyframe it names is a real `@keyframes` definition somewhere in the app's
 * CSS. See #1152.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { LoadTestMetrics } from "@/types";
import { RequestRateChart } from "./index";

function series(n: number): LoadTestMetrics[] {
	return Array.from({ length: n }, (_, i) => ({
		timestamp: i * 1000,
		elapsed_seconds: i,
		requests_completed: i * 100,
		requests_failed: i * 2,
		current_rps: 100 + i * 10,
		current_concurrency: i * 20,
		latency_p50_ms: 20 + i,
		latency_p95_ms: 40 + i * 3,
		latency_p99_ms: 80 + i * 8,
		avg_latency_ms: 25 + i,
		bytes_sent: i * 1000,
		bytes_received: i * 5000,
		send_rate: 110 + i * 10,
		throughput: 100 + i * 9,
		avg_queue_wait_ms: i * 0.5,
		status_codes: { "200": i * 90, "404": i * 5, "500": i * 3 },
	}));
}

describe("live-dot animation resolves to a real keyframe", () => {
	it("names a keyframe that is actually defined", () => {
		// Rendered half: mount a live chart and find the dot.
		const { container, unmount } = render(
			<RequestRateChart history={series(3)} isCompleted={false} />
		);
		const dot = container.querySelector("span[aria-hidden]");
		expect(dot).not.toBeNull();

		const className = dot!.className;
		expect(className.length).toBeGreaterThan(0);

		const match = className.match(/animate-\[([a-zA-Z0-9-]+)_/);
		expect(match).not.toBeNull();
		const animationName = match![1];

		unmount();

		// Definition half: read the app's actual CSS from disk - the import a
		// test sees is stubbed to "", which is how a guard like this passed for
		// weeks while reading nothing.
		const css = readFileSync(path.resolve(__dirname, "../../../../../index.css"), "utf-8");
		expect(css.length).toBeGreaterThan(0);

		const definedKeyframes = [...css.matchAll(/@keyframes\s+([a-zA-Z0-9-]+)/g)].map(
			(m) => m[1]
		);
		expect(definedKeyframes.length).toBeGreaterThan(0);

		expect(definedKeyframes).toContain(animationName);
	});

	it("keeps the shipped keyframe and the Tailwind config's copy in step", () => {
		// `vayu-pulse` is defined twice - in index.css, which ships, and in
		// tailwind.config.js, which backs the utility class. Reading one and
		// asserting nothing about the other is how the two drift apart.
		const css = readFileSync(path.resolve(__dirname, "../../../../../index.css"), "utf-8");
		const config = readFileSync(
			path.resolve(__dirname, "../../../../../../tailwind.config.js"),
			"utf-8"
		);
		expect(css.length).toBeGreaterThan(0);
		expect(config.length).toBeGreaterThan(0);

		expect(css).toContain("@keyframes vayu-pulse");
		expect(config).toContain('"vayu-pulse"');
	});
});
