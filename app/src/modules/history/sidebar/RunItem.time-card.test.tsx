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
 * A history row carries the time card (#1786). The row shows no time of its
 * own - the day heading above it says which day - so the card hangs off the
 * row's stretched activator, where the row's native `title` used to say the
 * same thing in one zone with none named. The status, which that title also
 * held, is a row of the card now; the run's comment is a line of the row itself
 * (`RunItem.result.test.tsx`).
 *
 * Assertions read labels and the extra rows, never the local row, so no case
 * depends on the host zone.
 *
 * Mutation check: unwrap the activator from `<TimeTooltip>` and the first case
 * fails.
 */

import { describe, it, expect } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import RunItem from "./RunItem";
import type { Run } from "@/types";

function run(overrides: Partial<Run> = {}): Run {
	return {
		id: "run_1",
		type: "design",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_003_000,
		requestId: "req_1",
		environmentId: null,
		summary: {
			url: "https://api.example.test/checkout",
			method: "POST",
			comment: "after the cache fix",
		},
		...overrides,
	} as Run;
}

const noop = () => {};

describe("the history row's time card", () => {
	it("opens from the row with the start time and the status, and leaves the comment to the row", async () => {
		render(<RunItem run={run()} onSelect={noop} onDelete={noop} isDeleting={false} />);
		fireEvent.focus(screen.getByRole("button", { name: /^Open .* run, completed/ }));
		const card = await screen.findByTestId("time-hover-card");
		expect(card.textContent).toContain("UTC");
		expect(card.textContent).toContain("StatusCompleted");
		// Said once, on the row: a second copy in the card is the duplicate.
		expect(card.textContent).not.toContain("after the cache fix");
		expect(card.textContent).not.toContain("Comment");
	});

	it("keeps no native title on the row to compete with the card", () => {
		const { container } = render(
			<RunItem run={run()} onSelect={noop} onDelete={noop} isDeleting={false} />
		);
		const row = container.querySelector<HTMLElement>(".focus-row");
		expect(row).not.toBeNull();
		expect(row!.hasAttribute("title")).toBe(false);
	});
});
