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
 * A run's status is not colour alone (#1691).
 *
 * The row carried a bare coloured dot, so five statuses were five identical
 * circles that a red/green confusion, a monochrome display or a greyscale
 * screenshot flattens into one. The fix is shape: a distinct glyph per status,
 * with the colour agreeing rather than carrying the message by itself.
 *
 * The assertion strips every `class` attribute before comparing, which is the
 * whole point - a guard that compared the rendered markup as-is would pass on
 * five identical dots wearing five different colour classes, which is exactly
 * the state this replaced. Mutation check: give every status the same `icon` in
 * `STATUS_GLYPH` and the first case fails while the colours still differ.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import RunItem from "./RunItem";
import type { Run } from "@/types";

const STATUSES: Run["status"][] = ["completed", "failed", "running", "stopped", "pending"];

function run(status: Run["status"]): Run {
	return {
		id: "run_1",
		type: "load",
		status,
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_003_000,
		requestId: "req_1",
		environmentId: null,
		summary: { url: "https://api.example.test/checkout", method: "POST" },
	} as Run;
}

const noop = () => {};

/** The status slot's markup with every colour class removed. */
function shapeOf(status: Run["status"]): string {
	const { container, unmount } = render(
		<RunItem run={run(status)} onSelect={noop} onDelete={noop} isDeleting={false} />
	);
	const glyph = container.querySelector("svg");
	expect(glyph).not.toBeNull();
	const markup = glyph!.outerHTML.replace(/class="[^"]*"/g, "");
	unmount();
	return markup;
}

describe("the run row's status affordance", () => {
	it("draws a different shape for every status, colour aside", () => {
		const shapes = STATUSES.map(shapeOf);

		// Non-empty scan: five statuses in, five shapes out, all distinct.
		expect(shapes).toHaveLength(STATUSES.length);
		expect(new Set(shapes).size).toBe(STATUSES.length);
	});

	it("still states the status in words for a screen reader", () => {
		// The glyph is decorative - the row's own accessible name carries the
		// status, so a reader hears it once rather than twice.
		render(<RunItem run={run("failed")} onSelect={noop} onDelete={noop} isDeleting={false} />);

		expect(screen.getByRole("button", { name: /load test run, failed/i })).toBeInTheDocument();
	});
});
