/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { buildNotices, type NoticeInputs } from "./notices";

const CLEAN: NoticeInputs = {
	rampDurationError: null,
	startFloorError: null,
	startConcurrencyError: null,
	capacityRangeError: null,
	budgetsError: null,
	monitoringError: null,
	scenarioOnlyError: null,
	hasPreRequestScript: false,
	hasPostRequestScript: false,
	scriptsOverride: "asMarked",
	defaultHeaderDifference: null,
	remoteTarget: null,
};

const keys = (overrides: Partial<NoticeInputs>) =>
	buildNotices({ ...CLEAN, ...overrides }).map((n) => n.key);

describe("buildNotices", () => {
	it("raises nothing for a clean draft", () => {
		expect(keys({})).toEqual([]);
	});

	it("sorts blocking notices above the warning and the info, whatever order they were found in", () => {
		expect(
			keys({
				defaultHeaderDifference: "Accept-Encoding differs",
				hasPreRequestScript: true,
				budgetsError: "p99 is out of range",
			})
		).toEqual(["budgets", "pre-script", "default-headers"]);
	});

	it("raises the off-network advisory as info, below every blocking notice", () => {
		const remoteTarget = { host: "api.example.com", requestCount: 6000, countWithheld: false };
		expect(keys({ remoteTarget })).toEqual(["remote-target"]);
		expect(buildNotices({ ...CLEAN, remoteTarget })[0].severity).toBe("info");
		expect(
			keys({
				remoteTarget,
				hasPreRequestScript: true,
				budgetsError: "p99 is out of range",
			})
		).toEqual(["budgets", "pre-script", "remote-target"]);
	});

	it("warns about a pre-request script at both settings that skip it", () => {
		expect(keys({ hasPreRequestScript: true, scriptsOverride: "asMarked" })).toEqual([
			"pre-script",
		]);
		expect(keys({ hasPreRequestScript: true, scriptsOverride: "allDeferred" })).toEqual([
			"pre-script",
		]);
	});

	it("drops the pre-request warning once Scripts is All inline", () => {
		expect(keys({ hasPreRequestScript: true, scriptsOverride: "allInline" })).toEqual([]);
	});

	it("says nothing about scripts when the request has no pre-request script", () => {
		expect(keys({ hasPreRequestScript: false, scriptsOverride: "asMarked" })).toEqual([]);
	});

	describe("carried budgets (#2194)", () => {
		const carriedBudgets = {
			summary: "Budgets carried over from Orders: p99.",
			onClear: vi.fn(),
		};

		it("raises an info notice only when something is carried", () => {
			expect(keys({ carriedBudgets })).toEqual(["carried-budgets"]);
			expect(keys({ carriedBudgets: null })).toEqual([]);
		});

		it("sorts beneath a blocking notice", () => {
			expect(keys({ carriedBudgets, budgetsError: "p99 is out of range" })).toEqual([
				"budgets",
				"carried-budgets",
			]);
		});

		it("shows the sentence and a button that clears", () => {
			// Mutation check: drop the `action` and the click finds no button.
			const onClear = vi.fn();
			const [notice] = buildNotices({
				...CLEAN,
				carriedBudgets: { summary: "Budgets carried over from Orders: p99.", onClear },
			});
			render(<>{notice.node}</>);
			expect(screen.getByText(/carried over from Orders/)).toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "Clear carried-over budgets" }));
			expect(onClear).toHaveBeenCalledTimes(1);
			cleanup();
		});
	});

	describe("scenario-only elements (#3050)", () => {
		const scenarioOnlyError =
			"A single-request load test can't run timer.pacing (set on this request).";

		it("raises a blocking notice, above the advisories", () => {
			expect(keys({ scenarioOnlyError, hasPreRequestScript: true })).toEqual([
				"scenario-only",
				"pre-script",
			]);
			expect(buildNotices({ ...CLEAN, scenarioOnlyError })[0].severity).toBe("blocking");
		});

		it("says nothing when no element needs a scenario", () => {
			expect(keys({ scenarioOnlyError: null })).toEqual([]);
		});

		it("shows the sentence and a button that runs the collection instead", () => {
			const onRunCollection = vi.fn();
			const [notice] = buildNotices({ ...CLEAN, scenarioOnlyError, onRunCollection });
			render(<>{notice.node}</>);
			expect(screen.getByText(/can't run timer\.pacing/)).toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "Run collection" }));
			expect(onRunCollection).toHaveBeenCalledTimes(1);
			cleanup();
		});

		it("offers no button where the request has no collection to run", () => {
			const [notice] = buildNotices({ ...CLEAN, scenarioOnlyError });
			render(<>{notice.node}</>);
			expect(screen.getByText(/can't run timer\.pacing/)).toBeInTheDocument();
			expect(screen.queryByRole("button")).toBeNull();
			cleanup();
		});
	});

	describe("the post-request sampling notice", () => {
		it("is included as an info notice for a replayed post-request script", () => {
			expect(keys({ hasPostRequestScript: true, scriptsOverride: "asMarked" })).toEqual([
				"post-script",
			]);
			expect(keys({ hasPostRequestScript: true, scriptsOverride: "allDeferred" })).toEqual([
				"post-script",
			]);
			const [notice] = buildNotices({ ...CLEAN, hasPostRequestScript: true });
			expect(notice.severity).toBe("info");
		});

		it("sorts below a blocking notice and the pre-request warning", () => {
			expect(
				keys({
					hasPostRequestScript: true,
					hasPreRequestScript: true,
					budgetsError: "p99 is out of range",
				})
			).toEqual(["budgets", "pre-script", "post-script"]);
		});

		it("is omitted once Scripts is All inline", () => {
			expect(keys({ hasPostRequestScript: true, scriptsOverride: "allInline" })).toEqual([]);
		});

		it("is omitted when no post-request script would be replayed", () => {
			expect(keys({ hasPostRequestScript: false, scriptsOverride: "asMarked" })).toEqual([]);
		});

		it("states the engine's sample period and cap, never a percentage", () => {
			const { container } = render(
				<>{buildNotices({ ...CLEAN, hasPostRequestScript: true }).map((n) => n.node)}</>
			);
			const text = container.textContent ?? "";
			expect(text.length).toBeGreaterThan(0);
			expect(text).toContain("about 1 in 100 responses (at most 1,000)");
			expect(text).toContain("assert.* elements check every response");
			expect(text).not.toContain("%");
		});
	});

	it("states the post-request sample once, not again in the pre-request warning", () => {
		const { container } = render(
			<>
				{buildNotices({ ...CLEAN, hasPreRequestScript: true }).map((n) => (
					<div key={n.key}>{n.node}</div>
				))}
			</>
		);
		const text = container.textContent ?? "";
		expect(text).toContain("Pre-request script won't run");
		expect(text).not.toMatch(/post-request/i);
	});
});
