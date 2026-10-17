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
 * A latency tile draws the value and the unit `formatLatencyParts` hands it, so
 * 1234 ms reads "1.23 s" on every tile and none carries a hand-written "ms"
 * (#2276). One mount per tile family: the stats row, the hero latency card and
 * the History tile.
 */

import { afterAll, describe, expect, it, vi } from "vitest";

// The formatters build their Intl.NumberFormat at module load, so the locale is
// pinned before the imports below run rather than left to the host.
const restoreIntl = vi.hoisted(() => {
	const Real = Intl.NumberFormat;
	class EnUsNumberFormat extends Real {
		constructor(_locale?: string | string[], options?: Intl.NumberFormatOptions) {
			super("en-US", options);
		}
	}
	Intl.NumberFormat = EnUsNumberFormat as typeof Intl.NumberFormat;
	return () => {
		Intl.NumberFormat = Real;
	};
});

afterAll(restoreIntl);

import type { ReactElement } from "react";
import { render } from "@/test/render-with-tooltips";
import LatencyMetric from "@/modules/history/main/components/LatencyMetric";
import { LatencyPercentilesCard } from "@/modules/dashboard/components/hero/LatencyPercentilesCard";
import {
	MeanIterTimeStat,
	P99AtPeakStat,
} from "@/modules/dashboard/components/stats/ModeStatCards";
import type { DashboardDerived } from "@/modules/dashboard/types";

function derived(ms: number): DashboardDerived {
	return {
		meanLatency: ms,
		p99Latency: ms,
		breakpoint: {
			crossed: false,
			concurrency: null,
			timeSeconds: null,
			p99Ms: null,
			sloMs: null,
		},
	} as DashboardDerived;
}

const tiles: Array<[string, (ms: number) => ReactElement]> = [
	["Mean iter time stat", (ms) => <MeanIterTimeStat d={derived(ms)} />],
	["p99 at peak stat", (ms) => <P99AtPeakStat d={derived(ms)} />],
	[
		"hero latency card",
		(ms) => <LatencyPercentilesCard p95={ms} p99={ms} meanLatency={ms} medianLatency={ms} />,
	],
	["History latency metric", (ms) => <LatencyMetric label="p99" value={ms} />],
];

describe.each(tiles)("%s", (_name, tile) => {
	const text = (ms: number) => render(tile(ms)).container.textContent ?? "";

	it("reads 1234 ms as seconds, with no millisecond unit left over", () => {
		const out = text(1234);
		expect(out).toMatch(/1\.23\s?s/);
		expect(out).not.toContain("ms");
		expect(out).not.toContain("1,234");
	});

	it("keeps milliseconds below a second", () => {
		expect(text(250)).toMatch(/250\s?ms/);
	});
});
