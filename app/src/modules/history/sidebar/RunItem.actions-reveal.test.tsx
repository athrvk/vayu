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
 * A history row's pin and delete give the name their width until the row is
 * hovered or focused (#3495).
 *
 * `opacity-0 group-hover:opacity-100` hides the buttons and keeps their 52px, so
 * at the 260px drawer the name had 107px. The buttons now leave the flow while
 * collapsed (`ROW_ACTIONS_REVEAL`) but stay in the DOM and out of `hidden`, so
 * Tab still reaches them and focus brings them back. jsdom has no layout, so the
 * rule is held as the rendered classes.
 */

import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { ROW_ACTIONS_REVEAL } from "@/components/shared";
import RunItem from "./RunItem";
import type { Run } from "@/types";

const run = (overrides: Partial<Run> = {}): Run =>
	({
		id: "run_1",
		type: "load",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_003_000,
		requestId: "req_1",
		environmentId: null,
		summary: { url: "https://api.example.test/checkout", method: "POST" },
		...overrides,
	}) as Run;

function renderRow(overrides: Partial<Run> = {}, props: { isDeleting?: boolean } = {}) {
	render(
		<RunItem
			run={run(overrides)}
			onSelect={() => {}}
			onDelete={vi.fn()}
			onToggleBaseline={vi.fn()}
			isDeleting={props.isDeleting ?? false}
		/>
	);
	const pin = screen.getByRole("button", { name: /^(Pin|Unpin) / });
	const del = screen.getByRole("button", { name: "Delete run" });
	return { pin, del, cluster: del.parentElement! };
}

/** Whether `el` leaves the row's flow until the row is revealed. */
const collapsed = (el: HTMLElement) =>
	el.classList.contains("absolute") &&
	el.classList.contains("group-hover:static") &&
	el.classList.contains("group-focus-within:static");

describe("RunItem row actions", () => {
	it("share one cluster that is collapsed at rest and revealed on hover or focus", () => {
		const { pin, del, cluster } = renderRow();
		expect(pin.parentElement).toBe(cluster);
		for (const token of ROW_ACTIONS_REVEAL.split(" ")) {
			expect(cluster.classList.contains(token), token).toBe(true);
		}
		expect(collapsed(cluster)).toBe(true);
		// The buttons ride the cluster; none carries a reservation of its own.
		expect(collapsed(pin)).toBe(false);
		expect(collapsed(del)).toBe(false);
	});

	// `hidden` / `invisible` would drop the buttons from the tab order, and a
	// keyboard user would never reach the control that focus is meant to reveal.
	it("stays focusable while collapsed", () => {
		const { del, cluster } = renderRow();
		for (const el of [cluster, del]) {
			for (const removed of ["hidden", "invisible", "sr-only"]) {
				expect(el.classList.contains(removed), removed).toBe(false);
			}
		}
		del.focus();
		expect(document.activeElement).toBe(del);
	});

	it("keeps a pinned run's pin in the flow and collapses only the delete", () => {
		const { pin, del, cluster } = renderRow({ baseline: true });
		expect(collapsed(cluster)).toBe(false);
		expect(collapsed(pin)).toBe(false);
		expect(collapsed(del)).toBe(true);
	});

	it("keeps the delete in the flow while it is deleting, and collapses the pin", () => {
		const { pin, del, cluster } = renderRow({}, { isDeleting: true });
		expect(collapsed(cluster)).toBe(false);
		expect(collapsed(del)).toBe(false);
		expect(collapsed(pin)).toBe(true);
	});
});
