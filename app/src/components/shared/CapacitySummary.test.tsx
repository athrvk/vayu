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
 * The capacity card exists to answer "what can my service take" without the
 * reader assembling it from a stat grid, so the ways it could mislead are the
 * cases worth pinning: claiming a sustained capacity for a search that found
 * none, naming a knee for a run that never watched the target give out, or
 * showing anything at all for a mode that never looked.
 */

import { describe, it, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CapacitySummary } from "./CapacitySummary";
import type { RunReport } from "@/types/domain";

type Capacity = NonNullable<RunReport["capacity"]>;

const capacity = (over: Partial<Capacity> = {}): Capacity => ({
	sloMs: 200,
	stopReason: "slo_exceeded",
	maxHealthyConcurrency: 48,
	maxHealthyRps: 23400,
	p99AtMaxHealthyMs: 41.2,
	kneeConcurrency: 64,
	kneeP99Ms: 312,
	levels: [
		{ concurrency: 48, rps: 23400, p99Ms: 41.2 },
		{ concurrency: 64, rps: 23000, p99Ms: 312 },
	],
	...over,
});

describe("CapacitySummary", () => {
	it("renders nothing for a run that was not a capacity search", () => {
		// Every fixed-target run is this run: it measured a point, not a curve,
		// and an empty shell would claim it looked for a limit and found none.
		const { container } = render(<CapacitySummary capacity={undefined} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("states the sustained capacity and the level that gave out", () => {
		render(<CapacitySummary capacity={capacity()} />);
		const headline = screen.getByText(/Sustained/).textContent ?? "";
		expect(headline).toContain("48");
		expect(headline).toContain("23,400");
		expect(headline).toContain("41.2ms");
		expect(headline).toContain("200ms budget");

		const knee = screen.getByText(/It gave out at/).textContent ?? "";
		expect(knee).toContain("64");
		expect(knee).toContain("312ms");
		cleanup();
	});

	it("says no level held rather than reporting a capacity of zero", () => {
		// The first level already breached, so `maxHealthy*` is absent. Rendering
		// it as 0 would read as a service that sustains nothing at all - a
		// different and much stronger claim than "we never found a level under
		// the budget".
		render(
			<CapacitySummary
				capacity={capacity({
					maxHealthyConcurrency: undefined,
					maxHealthyRps: undefined,
					p99AtMaxHealthyMs: undefined,
				})}
			/>
		);
		expect(screen.getByText(/No level met the 200ms budget/)).toBeTruthy();
		expect(screen.queryByText(/Sustained/)).toBeNull();
		cleanup();
	});

	it("omits the knee for a search that never watched the target break", () => {
		render(
			<CapacitySummary
				capacity={capacity({
					stopReason: "cap_reached",
					kneeConcurrency: undefined,
					kneeP99Ms: undefined,
					levels: [{ concurrency: 48, rps: 23400, p99Ms: 41.2 }],
				})}
			/>
		);
		expect(screen.queryByText(/It gave out at/)).toBeNull();
		expect(screen.getByText("Reached the concurrency ceiling")).toBeTruthy();
		cleanup();
	});

	it("shows a stop reason it has no words for rather than dropping it", () => {
		// A newer sidecar may stop for a reason this build predates; the levels
		// below still say what happened, so the badge falls back to the raw key.
		render(<CapacitySummary capacity={capacity({ stopReason: "thermal_throttle" })} />);
		expect(screen.getByText("thermal_throttle")).toBeTruthy();
		cleanup();
	});

	it("keeps a re-measured level as its own row in the audit trail", () => {
		// A level that breached once and was held to re-measure appears twice.
		// Keying the table by concurrency would collapse the pair and lose the
		// evidence for why the search stopped where it did.
		const { container } = render(
			<CapacitySummary
				capacity={capacity({
					levels: [
						{ concurrency: 48, rps: 23400, p99Ms: 41.2 },
						{ concurrency: 64, rps: 23000, p99Ms: 300 },
						{ concurrency: 64, rps: 22800, p99Ms: 312 },
					],
				})}
			/>
		);
		const rows = Array.from(container.querySelectorAll("tbody tr"));
		expect(rows).toHaveLength(3);
		expect(rows.map((row) => row.querySelector("td")?.textContent)).toEqual(["48", "64", "64"]);
		cleanup();
	});

	it("claims no measurement when the search judged nothing", () => {
		// `stepDuration` longer than `duration` - both accepted by the dialog and
		// the engine - ends the run before the first level closes. The engine
		// still reports the section (that the search judged nothing is itself
		// the finding), with `levels: []` and no `maxHealthy*`. Falling into the
		// "no level met the budget" branch would claim the target breached at
		// the lowest concurrency tried, contradicting the badge beside it.
		render(
			<CapacitySummary
				capacity={capacity({
					stopReason: "deadline",
					maxHealthyConcurrency: undefined,
					maxHealthyRps: undefined,
					p99AtMaxHealthyMs: undefined,
					kneeConcurrency: undefined,
					kneeP99Ms: undefined,
					levels: [],
				})}
			/>
		);
		expect(screen.getByText(/nothing to report about this target/)).toBeTruthy();
		expect(screen.queryByText(/No level met/)).toBeNull();
		expect(screen.queryByText(/Sustained/)).toBeNull();
		expect(screen.getByText("Ran out of time")).toBeTruthy();
		cleanup();
	});

	it("marks only the levels that broke the budget", () => {
		const { container } = render(<CapacitySummary capacity={capacity()} />);
		const cells = Array.from(container.querySelectorAll("td"));
		const p99Cells = cells.filter((cell) => cell.textContent?.endsWith("ms"));
		expect(p99Cells).toHaveLength(2);
		// Mutation check: compare against `>=` instead of `>` and the healthy
		// 41.2ms row starts wearing the warning colour too.
		expect(p99Cells[0].className).not.toContain("text-warning-text");
		expect(p99Cells[1].className).toContain("text-warning-text");
		cleanup();
	});
});
