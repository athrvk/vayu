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
 * Right-click on a history row (#1360).
 *
 * This row is the one that never had a `⋯` menu: its pin and its delete are
 * hover-revealed buttons. The menu is a second way to reach the *same two
 * handlers* - so what these cases pin is that it offers what the row offers, no
 * more (a run with nothing to compare against is not offered a baseline pin),
 * and that a selection from it reaches the handler with no event to stop.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import RunItem from "./RunItem";
import { CONTEXT_ATTRIBUTE } from "@/lib/context-menu";
import type { Run } from "@/types";

function run(overrides: Partial<Run> = {}): Run {
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

/** The row's own element - the card, which is the menu's trigger. */
const row = () => document.querySelector<HTMLElement>(`[${CONTEXT_ATTRIBUTE}="own-menu"]`)!;

describe("a history row's right-click menu", () => {
	it("offers the pin and the delete a load run's buttons offer", async () => {
		render(
			<RunItem
				run={run()}
				onSelect={noop}
				onDelete={noop}
				onToggleBaseline={noop}
				isDeleting={false}
			/>
		);

		fireEvent.contextMenu(row());

		await screen.findByRole("menu");
		expect(screen.getByRole("menuitem", { name: "Pin as baseline" })).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Delete run" })).toBeInTheDocument();
	});

	it("names the pin by what it would do next", async () => {
		render(
			<RunItem
				run={run({ baseline: true } as Partial<Run>)}
				onSelect={noop}
				onDelete={noop}
				onToggleBaseline={noop}
				isDeleting={false}
			/>
		);

		fireEvent.contextMenu(row());

		expect(await screen.findByRole("menuitem", { name: "Unpin baseline" })).toBeInTheDocument();
	});

	it("offers no baseline pin where the row has no pin button either", async () => {
		// A design run has nothing to compare against, so the list passes no
		// handler - and the menu must not invent an action the row cannot do.
		render(
			<RunItem
				run={run({ type: "design" })}
				onSelect={noop}
				onDelete={noop}
				isDeleting={false}
			/>
		);

		fireEvent.contextMenu(row());

		await screen.findByRole("menu");
		expect(screen.queryByRole("menuitem", { name: /baseline/i })).toBeNull();
		expect(screen.getByRole("menuitem", { name: "Delete run" })).toBeInTheDocument();
	});

	it("reaches the delete handler with no row event to stop", async () => {
		const onDelete = vi.fn();
		render(<RunItem run={run()} onSelect={noop} onDelete={onDelete} isDeleting={false} />);

		fireEvent.contextMenu(row());
		fireEvent.click(await screen.findByRole("menuitem", { name: "Delete run" }));

		await waitFor(() => expect(onDelete).toHaveBeenCalledWith("run_1"));
	});
});
