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
import { CONCURRENCY_LABEL } from "@/constants/load-test-modes";
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
		expect(headline).toContain("48 virtual users");
		expect(headline).toContain("23,400");
		expect(headline).toContain("41ms");
		expect(headline).toContain("200ms budget");

		const knee = screen.getByText(/It gave out at/).textContent ?? "";
		expect(knee).toContain("64 virtual users");
		expect(knee).toContain("312ms");
		cleanup();
	});

	it("heads the levels table with the app's one name for the count", () => {
		render(<CapacitySummary capacity={capacity()} />);
		expect(screen.getByRole("columnheader", { name: CONCURRENCY_LABEL })).toBeTruthy();
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
		expect(screen.getByText("Reached the virtual user ceiling")).toBeTruthy();
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
		// the fewest virtual users tried, contradicting the badge beside it.
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

	it("writes a latency of a second or more in seconds, from the shared formatter", () => {
		render(<CapacitySummary capacity={capacity({ kneeP99Ms: 1234, sloMs: 2000 })} />);
		expect(screen.getByText(/It gave out at/).textContent).toContain("1.23s");
		expect(screen.getByText(/Sustained/).textContent).toContain("2.00s budget");
		cleanup();
	});

	it("marks only the levels that broke the budget", () => {
		const { container } = render(<CapacitySummary capacity={capacity()} />);
		const cells = Array.from(container.querySelectorAll("td"));
		const p99Cells = cells.filter((cell) => cell.textContent?.endsWith("ms"));
		expect(p99Cells).toHaveLength(2);
		// Mutation check: compare against `>=` instead of `>` and the healthy
		// 41ms row starts wearing the warning colour too.
		expect(p99Cells[0].className).not.toContain("text-warning-text");
		expect(p99Cells[1].className).toContain("text-warning-text");
		cleanup();
	});

	it("paints the stop-reason chip through the Badge primitive, radius included", () => {
		// Same guard as `ThresholdVerdict`'s, for the same reason: the colour is
		// bound from `stop.degraded`, so only a render can see the class list,
		// and a missing radius class is invisible to any source scan.
		render(<CapacitySummary capacity={capacity()} />);
		const chip = screen.getByText("Latency budget exceeded");
		expect(chip.className).toMatch(/\brounded-(sm|md|lg)\b/);
		expect(chip.className).toContain("text-warning-text");
		cleanup();
	});

	describe("a search that stopped on errors", () => {
		const errorsStop = (over: Partial<Capacity> = {}): Capacity =>
			capacity({
				stopReason: "errors_exceeded",
				maxErrorPct: 1,
				kneeConcurrency: 33,
				kneeP99Ms: 80,
				kneeErrorPct: 94,
				levels: [
					{ concurrency: 16, rps: 9000, p99Ms: 40, errorPct: 0 },
					{ concurrency: 33, rps: 4000, p99Ms: 80, errorPct: 94 },
				],
				...over,
			});

		it("names the stop, the limit and the share of requests that failed", () => {
			render(<CapacitySummary capacity={errorsStop()} />);
			expect(screen.getByText("Errors exceeded the limit")).toBeTruthy();
			expect(
				screen.getByText("More than 1% of requests failed across two consecutive windows.")
			).toBeTruthy();

			const knee = screen.getByText(/It gave out at/).textContent ?? "";
			expect(knee).toContain("33 virtual users");
			expect(knee).toContain("94.0% of requests failed");
			// The latency was fine at the knee; quoting it would blame the wrong thing.
			expect(knee).not.toContain("p99");
			cleanup();
		});

		it("falls back to generic wording when the report carries no limit", () => {
			render(<CapacitySummary capacity={errorsStop({ maxErrorPct: undefined })} />);
			expect(screen.getByText(/More requests failed than the limit allows/)).toBeTruthy();
			cleanup();
		});

		it("says the error limit, not the latency budget, when no level held", () => {
			render(
				<CapacitySummary
					capacity={errorsStop({
						maxHealthyConcurrency: undefined,
						maxHealthyRps: undefined,
						p99AtMaxHealthyMs: undefined,
					})}
				/>
			);
			expect(screen.getByText(/No level stayed under the error limit/)).toBeTruthy();
			expect(screen.queryByText(/budget - the target/)).toBeNull();
			expect(screen.queryByText(/Sustained/)).toBeNull();
			cleanup();
		});

		it("adds an Errors column and tints only the level over the limit", () => {
			const { container } = render(<CapacitySummary capacity={errorsStop()} />);
			expect(screen.getByRole("columnheader", { name: "Errors" })).toBeTruthy();

			const errorCells = Array.from(container.querySelectorAll("tbody tr")).map(
				(row) => row.querySelectorAll("td")[3]
			);
			expect(errorCells.map((cell) => cell.textContent)).toEqual(["0.0%", "94.0%"]);
			expect(errorCells[0].className).not.toContain("text-warning-text");
			expect(errorCells[1].className).toContain("text-warning-text");
			cleanup();
		});

		it("headlines the last healthy level of the audit run, never the ceiling", () => {
			// #2815, audit S3: 94% of requests failed fast at 33 virtual users and
			// the card read "Sustained 50", the search ceiling it never reached.
			render(
				<CapacitySummary
					capacity={errorsStop({
						maxHealthyConcurrency: 27,
						maxHealthyRps: 1080,
						p99AtMaxHealthyMs: 77,
						kneeP99Ms: 81,
						levels: [
							{ concurrency: 22, rps: 880, p99Ms: 75, errorPct: 0 },
							{ concurrency: 27, rps: 1080, p99Ms: 77, errorPct: 0 },
							{ concurrency: 33, rps: 1132, p99Ms: 81, errorPct: 94 },
							{ concurrency: 33, rps: 1132, p99Ms: 81, errorPct: 94 },
						],
					})}
				/>
			);
			const headline = screen.getByText(/Sustained/).textContent ?? "";
			expect(headline).toContain("27 virtual users");
			expect(document.body.textContent).not.toContain("Sustained 50");
			expect(screen.getByText(/It gave out at/).textContent).toContain(
				"94.0% of requests failed"
			);
			cleanup();
		});

		it("falls back to the p99 sentence when an errors stop carries no error share", () => {
			// A report written before `kneeErrorPct` existed: the knee still has to
			// say something, and the latency is the only evidence it holds.
			render(<CapacitySummary capacity={errorsStop({ kneeErrorPct: undefined })} />);
			const knee = screen.getByText(/It gave out at/).textContent ?? "";
			expect(knee).toContain("33 virtual users");
			expect(knee).toContain("p99 reached 80ms");
			expect(knee).not.toContain("of requests failed");
			cleanup();
		});

		it("tints nothing when the report carries no limit to compare against", () => {
			const { container } = render(
				<CapacitySummary capacity={errorsStop({ maxErrorPct: undefined })} />
			);
			const cells = Array.from(container.querySelectorAll("tbody tr")).map(
				(row) => row.querySelectorAll("td")[3]
			);
			expect(cells.map((cell) => cell.textContent)).toEqual(["0.0%", "94.0%"]);
			for (const cell of cells) expect(cell.className).not.toContain("text-warning-text");
			cleanup();
		});
	});

	it("keeps three columns for a run stored before errors were judged", () => {
		// The default fixture is that shape: no `errorPct`, no `maxErrorPct`.
		const { container } = render(<CapacitySummary capacity={capacity()} />);
		expect(screen.queryByRole("columnheader", { name: "Errors" })).toBeNull();
		for (const row of container.querySelectorAll("tbody tr")) {
			expect(row.querySelectorAll("td")).toHaveLength(3);
		}
		cleanup();
	});

	it("never prints 0ms for a knee that carries no p99", () => {
		render(<CapacitySummary capacity={capacity({ kneeP99Ms: undefined })} />);
		const knee = screen.getByText(/It gave out at/).textContent ?? "";
		expect(knee).toContain("64 virtual users");
		expect(knee).not.toContain("0ms");
		expect(knee).not.toContain("p99");
		cleanup();
	});

	it("declares the surface its table dividers read", () => {
		const { container } = render(<CapacitySummary capacity={capacity()} />);
		const rules = Array.from(container.querySelectorAll(".border-rule"));

		// The header row and one row per level.
		// A render that reached no divider would pass the loop below having
		// checked nothing.
		expect(rules.length).toBeGreaterThanOrEqual(3);
		for (const rule of rules) {
			expect(
				rule.closest(".surface-card, .surface-sunken"),
				`border-rule under no surface: ${rule.getAttribute("class")}`
			).not.toBeNull();
		}
	});
});
