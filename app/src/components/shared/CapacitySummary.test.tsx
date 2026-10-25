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

		const knee = screen.getByText(/The limit lies between/).textContent ?? "";
		expect(knee).toBe(
			"The limit lies between 48 and 64 virtual users: it held 48 and gave out at 64, where p99 reached 312ms."
		);
		cleanup();
	});

	it("names only the level that gave out when no level held", () => {
		// With nothing held there is no bracket to draw: the knee is the first
		// level tried, and "between" would need a lower bound the search never had.
		render(
			<CapacitySummary
				capacity={capacity({
					maxHealthyConcurrency: undefined,
					maxHealthyRps: undefined,
					p99AtMaxHealthyMs: undefined,
				})}
			/>
		);
		const knee = screen.getByText(/It gave out at/).textContent ?? "";
		expect(knee).toContain("64 virtual users");
		expect(screen.queryByText(/The limit lies between/)).toBeNull();
		cleanup();
	});

	describe("the stop detail names measurements of a level, never windows", () => {
		it("words a latency stop as consecutive measurements and omits the step length when absent", () => {
			render(<CapacitySummary capacity={capacity()} />);
			expect(
				screen.getByText(
					"p99 stayed above the budget across two consecutive measurements of the level."
				)
			).toBeTruthy();
			cleanup();
		});

		it("names the step length when the report carries one", () => {
			render(<CapacitySummary capacity={capacity()} stepDuration="5s" />);
			expect(
				screen.getByText(
					"p99 stayed above the budget across two consecutive measurements of the level (each 5s long)."
				)
			).toBeTruthy();
			cleanup();
		});

		it.each([
			["slo_exceeded", {}],
			["slo_exceeded", { stepDuration: "5s" }],
			["errors_exceeded", { maxErrorPct: 1 }],
			["errors_exceeded", { maxErrorPct: 1, stepDuration: "5s" }],
			["errors_exceeded", {}],
			["plateau", { saturationP99Ms: 52 }],
			["plateau", {}],
			["cap_reached", {}],
			["deadline", {}],
			["stopped", {}],
		])("never calls a level a window: %s %j", (stopReason, extra) => {
			const { stepDuration, ...over } = extra as Partial<Capacity> & {
				stepDuration?: string;
			};
			const { container } = render(
				<CapacitySummary
					capacity={capacity({ stopReason, ...over })}
					stepDuration={stepDuration}
				/>
			);
			expect(container.textContent).not.toMatch(/window/i);
			cleanup();
		});
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
		expect(screen.queryByText(/The limit lies between/)).toBeNull();
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
		// The concurrency is the cell's first node; the label is a sibling after it.
		expect(rows.map((row) => row.querySelector("td")?.firstChild?.textContent)).toEqual([
			"48",
			"64",
			"64",
		]);
		cleanup();
	});

	it("labels a level the search measured again, on the repeat only", () => {
		// Mutation check: drop the `seen.has` comparison in `repeatedLevels` (label
		// every row, or none) and this fails.
		const { container } = render(
			<CapacitySummary
				capacity={capacity({
					levels: [
						{ concurrency: 48, rps: 23400, p99Ms: 41.2 },
						{ concurrency: 64, rps: 23000, p99Ms: 300 },
						{ concurrency: 64, rps: 22800, p99Ms: 312 },
						{ concurrency: 64, rps: 22900, p99Ms: 305 },
					],
				})}
			/>
		);
		const firstCells = Array.from(container.querySelectorAll("tbody tr")).map(
			(row) => row.querySelector("td")?.textContent
		);
		expect(firstCells).toEqual(["48", "64", "64 re-measured", "64 re-measured"]);
		// Plain muted text: the row already carries the number, a chip would shout.
		const label = screen.getAllByText("re-measured")[0];
		expect(label.className).toContain("text-muted-foreground");
		expect(label.tagName).toBe("SPAN");
		cleanup();
	});

	it("labels nothing when every level is measured once", () => {
		render(<CapacitySummary capacity={capacity()} />);
		expect(screen.queryByText("re-measured")).toBeNull();
		cleanup();
	});

	describe("the headline follows why the search stopped", () => {
		const headlineOf = (cap: Capacity): string => {
			const { container } = render(<CapacitySummary capacity={cap} />);
			const text = container.querySelector("p")?.textContent ?? "";
			cleanup();
			return text;
		};

		// Audit S1: throughput flat at 156 req/s from 8 virtual users on, p99
		// climbing from 52ms to 103ms. The last level tried (12) is where the
		// search ran out of patience, not where the curve flattened.
		const plateau = (over: Partial<Capacity> = {}): Capacity =>
			capacity({
				stopReason: "plateau",
				maxHealthyConcurrency: 12,
				maxHealthyRps: 156,
				p99AtMaxHealthyMs: 103,
				kneeConcurrency: undefined,
				kneeP99Ms: undefined,
				saturationConcurrency: 8,
				saturationRps: 156,
				saturationP99Ms: 52,
				levels: [
					{ concurrency: 8, rps: 156, p99Ms: 52 },
					{ concurrency: 10, rps: 156, p99Ms: 103 },
					{ concurrency: 12, rps: 156, p99Ms: 103 },
				],
				...over,
			});

		it("puts a plateau where throughput stopped growing, not at the last level tried", () => {
			const headline = headlineOf(plateau());
			expect(headline).toBe(
				"Throughput stopped growing at 8 virtual users (156 req/s, p99 52ms). More only queued."
			);
			expect(headline).not.toContain("Sustained");
			expect(headline).not.toContain("12");
			expect(headline).not.toContain("103ms");
		});

		it("names no level for a plateau stored before the engine reported one", () => {
			const headline = headlineOf(
				plateau({
					saturationConcurrency: undefined,
					saturationRps: undefined,
					saturationP99Ms: undefined,
				})
			);
			expect(headline).toBe("Throughput stopped growing. More only queued.");
		});

		it("quotes the p99 rise from the saturation level to the last level tried", () => {
			render(<CapacitySummary capacity={plateau()} />);
			expect(
				screen.getByText(
					"More virtual users stopped buying more throughput; p99 stayed inside the budget but rose from 52ms to 103ms."
				)
			).toBeTruthy();
			cleanup();
		});

		it("says nothing of latency when the last level's p99 did not rise", () => {
			render(
				<CapacitySummary
					capacity={plateau({
						levels: [
							{ concurrency: 8, rps: 156, p99Ms: 52 },
							{ concurrency: 10, rps: 156, p99Ms: 52 },
							{ concurrency: 12, rps: 156, p99Ms: 48 },
						],
					})}
				/>
			);
			expect(
				screen.getByText("More virtual users stopped buying more throughput.")
			).toBeTruthy();
			expect(screen.queryByText(/rose/)).toBeNull();
			cleanup();
		});

		it("falls back to the plain sentence for a plateau with no saturation figures", () => {
			render(
				<CapacitySummary
					capacity={plateau({
						saturationConcurrency: undefined,
						saturationRps: undefined,
						saturationP99Ms: undefined,
					})}
				/>
			);
			expect(
				screen.getByText("More virtual users stopped buying more throughput.")
			).toBeTruthy();
			expect(screen.queryByText(/rose|still held/)).toBeNull();
			cleanup();
		});

		it("falls back to the plain sentence for a plateau with no levels", () => {
			render(<CapacitySummary capacity={plateau({ levels: [] })} />);
			expect(
				screen.getByText("More virtual users stopped buying more throughput.")
			).toBeTruthy();
			cleanup();
		});

		it("reads a ceiling stop as a floor, never as Sustained", () => {
			const headline = headlineOf(
				capacity({
					stopReason: "cap_reached",
					maxHealthyConcurrency: 30,
					maxHealthyRps: 295,
					p99AtMaxHealthyMs: 41.2,
					kneeConcurrency: undefined,
					kneeP99Ms: undefined,
					levels: [
						{ concurrency: 20, rps: 200, p99Ms: 30 },
						{ concurrency: 30, rps: 295, p99Ms: 41.2 },
					],
				})
			);
			expect(headline).toBe(
				"At least 30 virtual users held the budget (295 req/s, p99 41ms). The search did not find a limit."
			);
			expect(headline).not.toContain("Sustained");
		});

		it.each(["deadline", "stopped"])(
			"reads a %s stop after four levels as a floor with the next level unfinished",
			(stopReason) => {
				const headline = headlineOf(
					capacity({
						stopReason,
						maxHealthyConcurrency: 4,
						maxHealthyRps: 80,
						p99AtMaxHealthyMs: 20,
						kneeConcurrency: undefined,
						kneeP99Ms: undefined,
						levels: [
							{ concurrency: 1, rps: 20, p99Ms: 18 },
							{ concurrency: 2, rps: 40, p99Ms: 19 },
							{ concurrency: 3, rps: 60, p99Ms: 19 },
							{ concurrency: 4, rps: 80, p99Ms: 20 },
						],
					})
				);
				expect(headline).toBe(
					"At least 4 virtual users held the budget (80 req/s, p99 20ms). The search did not find a limit. The next level was still being measured."
				);
				expect(headline).not.toContain("Sustained");
			}
		);

		it("does not claim an unfinished next level for a ceiling stop", () => {
			const headline = headlineOf(capacity({ stopReason: "cap_reached" }));
			expect(headline).toContain("At least 48 virtual users");
			expect(headline).not.toContain("next level");
		});

		it("keeps Sustained for the two stops that watched the target give out", () => {
			for (const stopReason of ["slo_exceeded", "errors_exceeded"]) {
				const headline = headlineOf(capacity({ stopReason }));
				expect(headline).toContain("Sustained 48 virtual users");
				expect(headline).not.toContain("At least");
			}
		});

		it("brackets the limit between the level that held and the one that gave out", () => {
			render(
				<CapacitySummary
					capacity={capacity({
						maxHealthyConcurrency: 41,
						kneeConcurrency: 51,
						kneeP99Ms: 230,
					})}
				/>
			);
			expect(screen.getByText(/The limit lies between/).textContent).toBe(
				"The limit lies between 41 and 51 virtual users: it held 41 and gave out at 51, where p99 reached 230ms."
			);
			cleanup();
		});
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
		expect(screen.getByText(/The limit lies between/).textContent).toContain("1.23s");
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
				maxHealthyConcurrency: 16,
				maxHealthyRps: 9000,
				p99AtMaxHealthyMs: 40,
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
				screen.getByText(
					"More than 1% of requests failed across two consecutive measurements of the level."
				)
			).toBeTruthy();

			const knee = screen.getByText(/The limit lies between/).textContent ?? "";
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

		it("names the step length beside the limit when the report carries one", () => {
			render(<CapacitySummary capacity={errorsStop()} stepDuration="5s" />);
			expect(
				screen.getByText(
					"More than 1% of requests failed across two consecutive measurements of the level (each 5s long)."
				)
			).toBeTruthy();
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
			expect(screen.getByText(/The limit lies between/).textContent).toContain(
				"94.0% of requests failed"
			);
			cleanup();
		});

		it("falls back to the p99 sentence when an errors stop carries no error share", () => {
			// A report written before `kneeErrorPct` existed: the knee still has to
			// say something, and the latency is the only evidence it holds.
			render(<CapacitySummary capacity={errorsStop({ kneeErrorPct: undefined })} />);
			const knee = screen.getByText(/The limit lies between/).textContent ?? "";
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

	describe("the Samples column", () => {
		const withSamples = (samples: (number | undefined)[]): Capacity =>
			capacity({
				levels: [
					{ concurrency: 48, rps: 23400, p99Ms: 41.2, samples: samples[0] },
					{ concurrency: 64, rps: 23000, p99Ms: 312, samples: samples[1] },
				],
			});
		const column = (container: HTMLElement, index: number): (string | null)[] =>
			Array.from(container.querySelectorAll("tbody tr")).map(
				(row) => row.querySelectorAll("td")[index].textContent
			);

		it("prints the completions behind each row, after p99, under a pinned header", () => {
			const { container } = render(<CapacitySummary capacity={withSamples([4900, 12])} />);
			const headers = screen.getAllByRole("columnheader").map((th) => th.textContent);
			expect(headers).toEqual([CONCURRENCY_LABEL, "Throughput", "p99", "Samples"]);
			expect(column(container, 3)).toEqual(["4,900", "12"]);
			const cell = container.querySelectorAll("tbody tr")[0].querySelectorAll("td")[3];
			expect(cell.className).toContain("text-muted-foreground");
			expect(cell.className).toContain("text-right");
			expect(cell.className).toContain("font-mono");
			cleanup();
		});

		it("leaves a level without a count empty rather than printing 0", () => {
			// Mutation check: render `level.samples ?? 0` and the absent cell reads
			// "0", the claim that a level of refused connections is exactly this.
			const { container } = render(
				<CapacitySummary capacity={withSamples([4900, undefined])} />
			);
			expect(column(container, 3)).toEqual(["4,900", ""]);
			cleanup();
		});

		it("prints 0 for a level whose p99 measured nothing", () => {
			const { container } = render(<CapacitySummary capacity={withSamples([4900, 0])} />);
			expect(column(container, 3)).toEqual(["4,900", "0"]);
			cleanup();
		});

		it("omits the column for a run stored before the engine reported it", () => {
			render(<CapacitySummary capacity={withSamples([undefined, undefined])} />);
			expect(screen.queryByRole("columnheader", { name: "Samples" })).toBeNull();
			cleanup();
		});

		it("follows Errors when both are present, with the gutter on every column but the last", () => {
			const { container } = render(
				<CapacitySummary
					capacity={capacity({
						levels: [
							{
								concurrency: 48,
								rps: 23400,
								p99Ms: 41.2,
								errorPct: 0,
								samples: 4900,
							},
							{ concurrency: 64, rps: 23000, p99Ms: 312, errorPct: 94, samples: 0 },
						],
					})}
				/>
			);
			const headers = screen.getAllByRole("columnheader");
			expect(headers.map((th) => th.textContent)).toEqual([
				CONCURRENCY_LABEL,
				"Throughput",
				"p99",
				"Errors",
				"Samples",
			]);
			for (const row of container.querySelectorAll("tbody tr")) {
				expect(row.querySelectorAll("td")).toHaveLength(5);
			}
			expect(column(container, 3)).toEqual(["0.0%", "94.0%"]);
			expect(column(container, 4)).toEqual(["4,900", "0"]);
			// Only the rightmost column sits flush; p99 and Errors leave a gutter.
			const [, , p99, errors, samples] = headers;
			expect(p99.className).toContain("pr-3");
			expect(errors.className).toContain("pr-3");
			expect(samples.className).not.toContain("pr-3");
			cleanup();
		});

		it.each([
			["p99 alone", capacity(), "p99"],
			[
				"Errors",
				capacity({ levels: [{ concurrency: 48, rps: 1, p99Ms: 1, errorPct: 0 }] }),
				"Errors",
			],
			["Samples", withSamples([1, 2]), "Samples"],
		])("sits the %s column flush and leaves a gutter before it", (_name, cap, lastHeader) => {
			render(<CapacitySummary capacity={cap} />);
			const headers = screen.getAllByRole("columnheader");
			const last = headers[headers.length - 1];
			expect(last.textContent).toBe(lastHeader);
			expect(last.className).not.toContain("pr-3");
			for (const header of headers.slice(1, -1)) expect(header.className).toContain("pr-3");
			cleanup();
		});
	});

	it("never prints 0ms for a knee that carries no p99", () => {
		render(<CapacitySummary capacity={capacity({ kneeP99Ms: undefined })} />);
		const knee = screen.getByText(/The limit lies between/).textContent ?? "";
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
