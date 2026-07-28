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
 * Behaviour of the shared sampled-exchange shell.
 *
 * Its adoption by the two views is guarded separately, in
 * `sampled-exchange-adoption.test.tsx`. This file is about the shell itself -
 * the parts that used to be decided twice, differently, and that a caller now
 * gets for free.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { TooltipProvider } from "@/components/ui";

import { SampledExchange } from "./SampledExchange";
import { phasesFromTrace } from "./timing-phases";

const base = {
	label: 3,
	statusCode: 200,
	statusText: "OK",
	latencyMs: 12.34,
	timestamp: "10:11:12.345",
	isExpanded: false,
	onToggle: () => {},
};

describe("SampledExchange", () => {
	it("exposes the summary as one button whose aria-expanded tracks the state", () => {
		const { rerender } = render(<SampledExchange {...base} />);

		const row = screen.getByRole("button");
		expect(row).toHaveAttribute("aria-expanded", "false");

		rerender(<SampledExchange {...base} isExpanded />);
		expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
	});

	it("leaves expansion to the parent - clicking only calls onToggle", () => {
		const onToggle = vi.fn();
		render(
			<SampledExchange {...base} onToggle={onToggle}>
				<p>detail</p>
			</SampledExchange>
		);

		fireEvent.click(screen.getByRole("button"));

		expect(onToggle).toHaveBeenCalledTimes(1);
		// Still collapsed: the shell holds no state of its own, which is what
		// lets the dashboard keep a Set of open indices and the history detail
		// a single one.
		expect(screen.queryByText("detail")).toBeNull();
	});

	it("renders the expanded sections in order: error, details, timing, children", () => {
		// The timing tiles carry InfoChips, and the tooltip delay is set once at
		// the app root - so the harness supplies the provider, as the app does.
		render(
			<TooltipProvider>
				<SampledExchange
					{...base}
					isExpanded
					error="connect: timed out"
					phases={phasesFromTrace({ dnsMs: 1 })}
					details={<p>the-details</p>}
				>
					<p>the-children</p>
				</SampledExchange>
			</TooltipProvider>
		);

		const text = document.body.textContent ?? "";
		const order = ["connect: timed out", "the-details", "Timing Breakdown", "the-children"].map(
			(t) => text.indexOf(t)
		);
		expect(order.every((i) => i >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	it("previews only the first clause of an error on the collapsed row", () => {
		render(<SampledExchange {...base} error="connect: connection refused after 3 tries" />);

		// The row shows the class of failure; the full message is one click away.
		// A multi-line curl error would otherwise push the row to three lines.
		expect(screen.getByText("connect")).toBeInTheDocument();
		expect(screen.queryByText(/connection refused/)).toBeNull();
	});

	it("treats a zero status code as a failure even with no error string", () => {
		// A connection failure has no status code to show, so the icon is the
		// only thing on the row that says "this one did not come back".
		const { container } = render(<SampledExchange {...base} statusCode={0} />);

		expect(container.querySelector(".text-destructive-text")).not.toBeNull();
		expect(container.querySelector(".text-status-success-text")).toBeNull();
	});

	it("marks a slow sample on both the icon and the latency", () => {
		const { container } = render(<SampledExchange {...base} isSlow />);

		expect(container.querySelectorAll(".text-status-stopped-text")).toHaveLength(2);
	});

	it("omits the timing heading when no phase was reported", () => {
		// The heading used to be gated separately from its content, so a trace
		// with only TTFB and download printed a heading over nothing.
		render(<SampledExchange {...base} isExpanded phases={phasesFromTrace({})} />);

		expect(screen.queryByText("Timing Breakdown")).toBeNull();
	});
});
