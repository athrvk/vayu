/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A run pane's grids answer to the pane, not the window (#2272).
 *
 * The context bar is a fixed-width aside, so the pane is narrower than the
 * viewport by an amount no `lg:` variant knows about; `lg:grid-cols-6` fired at
 * a 1024px window and clipped the P99 tile with the bar open. The grids use
 * container variants (`@md:`, `@3xl:`) under an `@container` pane root.
 *
 * Layout does not exist in jsdom, so this reads the source: it cannot prove a
 * tile fits, only that no run-pane grid went back to a viewport breakpoint and
 * that the roots the container variants resolve against are still declared.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dashboard = join(here, "../../dashboard/components");

function read(path: string): string {
	return readFileSync(path, "utf8");
}

/** Grids that render inside a run pane, reached from `LoadTestDetail`. */
const RUN_PANE_GRID_FILES = [
	join(here, "components/PerformanceTab.tsx"),
	join(here, "components/OverviewTab.tsx"),
	join(here, "components/RunKeyMetrics.tsx"),
	join(here, "components/MonitorSummary.tsx"),
	join(here, "components/BaselineComparison.tsx"),
	join(here, "components/RunTrend.tsx"),
	join(dashboard, "MetricsView.tsx"),
];

/** `lg:grid-cols-6` but not `@lg:grid-cols-6`. */
const VIEWPORT_GRID_VARIANT = /(?<![@\w-])(?:sm|md|lg|xl|2xl):grid-cols-/;

describe("run-pane grids", () => {
	it.each(RUN_PANE_GRID_FILES)("%s uses no viewport grid-cols variant", (file) => {
		const source = read(file);
		// A guard over an empty read passes forever.
		expect(source.length).toBeGreaterThan(0);
		expect(source).toMatch(/grid-cols-/);
		expect(source).not.toMatch(VIEWPORT_GRID_VARIANT);
	});

	it("keeps the Performance tab's latency tiles on a container variant", () => {
		const source = read(join(here, "components/PerformanceTab.tsx"));
		expect(source.length).toBeGreaterThan(0);
		expect(source).not.toContain("lg:grid-cols-");
		expect(source).toMatch(/@3xl:grid-cols-6/);
	});

	it.each([
		["LoadTestDetail.tsx", join(here, "LoadTestDetail.tsx")],
		["MetricsView.tsx", join(dashboard, "MetricsView.tsx")],
	])("%s declares the @container its grids resolve against", (_name, file) => {
		const source = read(file);
		expect(source.length).toBeGreaterThan(0);
		expect(source).toMatch(/className="@container /);
	});

	it("the pattern separates a viewport variant from a container one", () => {
		expect("grid lg:grid-cols-6").toMatch(VIEWPORT_GRID_VARIANT);
		expect("grid sm:grid-cols-3").toMatch(VIEWPORT_GRID_VARIANT);
		expect("grid @lg:grid-cols-6").not.toMatch(VIEWPORT_GRID_VARIANT);
		expect("grid @md:grid-cols-3").not.toMatch(VIEWPORT_GRID_VARIANT);
	});
});
