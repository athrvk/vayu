/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @vitest-environment jsdom
 */

/**
 * Pinning a run as the baseline, from its sidebar row.
 *
 * The row is the only place a pin is set, and the only place a reader can see
 * that one exists - so both halves are asserted here: the action toggles to the
 * *opposite* of the current state (a pin button that always pins cannot unpin),
 * and a pinned row says so without being hovered.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import RunItem from "./RunItem";
import type { Run } from "@/types";

function loadRun(overrides: Partial<Run> = {}): Run {
	return {
		id: "run_1",
		type: "load",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_003_000,
		requestId: "req_1",
		environmentId: null,
		summary: { url: "https://api.example.test/checkout", method: "POST" },
		...overrides,
	} as Run;
}

const noop = () => {};

describe("RunItem baseline pin", () => {
	it("pins an unpinned run", () => {
		const onToggleBaseline = vi.fn();
		render(
			<RunItem
				run={loadRun()}
				onSelect={noop}
				onDelete={vi.fn()}
				onToggleBaseline={onToggleBaseline}
				isDeleting={false}
			/>
		);

		fireEvent.click(screen.getByRole("button", { name: "Pin as baseline" }));
		expect(onToggleBaseline).toHaveBeenCalledWith("run_1", true, expect.anything());
	});

	it("unpins a pinned run - the action follows the run's state, not a constant", () => {
		const onToggleBaseline = vi.fn();
		render(
			<RunItem
				run={loadRun({ baseline: true })}
				onSelect={noop}
				onDelete={vi.fn()}
				onToggleBaseline={onToggleBaseline}
				isDeleting={false}
			/>
		);

		const action = screen.getByRole("button", { name: "Unpin baseline" });
		expect(action).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(action);
		expect(onToggleBaseline).toHaveBeenCalledWith("run_1", false, expect.anything());
	});

	it("marks a pinned row, and leaves an unpinned one unmarked", () => {
		const { unmount } = render(
			<RunItem
				run={loadRun({ baseline: true })}
				onSelect={noop}
				onDelete={vi.fn()}
				onToggleBaseline={vi.fn()}
				isDeleting={false}
			/>
		);
		expect(screen.getByText("Baseline")).toBeInTheDocument();
		unmount();

		render(
			<RunItem
				run={loadRun()}
				onSelect={noop}
				onDelete={vi.fn()}
				onToggleBaseline={vi.fn()}
				isDeleting={false}
			/>
		);
		expect(screen.queryByText("Baseline")).not.toBeInTheDocument();
	});

	/*
	 * The chip paints its own background, so it must be `variant="chip"` - every
	 * other Badge variant pairs `bg-x` with a `hover:bg-x/80` that tailwind-merge
	 * keeps, turning the chip the accent colour under the pointer
	 * (`badge-hover.test.tsx` is the general form of this rule). A source scan
	 * cannot see it, so the rendered class list is what is read.
	 */
	it("draws the chip with no hover background", () => {
		render(
			<RunItem
				run={loadRun({ baseline: true })}
				onSelect={noop}
				onDelete={vi.fn()}
				onToggleBaseline={vi.fn()}
				isDeleting={false}
			/>
		);

		const chip = screen.getByText("Baseline").closest("[data-slot='badge']");
		expect(chip).not.toBeNull();
		expect(chip!.className).toContain("bg-primary/15");
		expect(chip!.className).not.toMatch(/hover:bg-/);
	});

	/*
	 * Only a load run gets the action. A design run's "report" is one exchange
	 * and a collection run's is a step list - neither has percentiles, throughput
	 * or an error rate to diff, so a pin on one would promise a comparison
	 * nothing can render.
	 */
	it.each(["design", "scenario"] as const)("offers no pin on a %s run", (type) => {
		render(
			<RunItem
				run={loadRun({ type, baseline: false })}
				onSelect={noop}
				onDelete={vi.fn()}
				onToggleBaseline={vi.fn()}
				isDeleting={false}
			/>
		);
		expect(screen.queryByRole("button", { name: /baseline/i })).not.toBeInTheDocument();
	});

	it("offers no pin when the list passes no handler", () => {
		render(<RunItem run={loadRun()} onSelect={noop} onDelete={vi.fn()} isDeleting={false} />);
		expect(screen.queryByRole("button", { name: /baseline/i })).not.toBeInTheDocument();
	});
});
