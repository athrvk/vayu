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
import { formatLatency } from "@/lib/format-number";

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
	it("draws no status badge and no time for an exchange that never reached the wire", () => {
		// A skipped step (#2824): `0` would read as "ERR" and "0ms".
		render(
			<SampledExchange
				{...base}
				statusCode={undefined}
				latencyMs={undefined}
				state="skipped"
			/>
		);

		expect(screen.queryByText("ERR")).toBeNull();
		expect(screen.queryByText(/ms$/)).toBeNull();
		expect(screen.queryByText("200")).toBeNull();
	});

	it("does not read an absent status as an error", () => {
		render(<SampledExchange {...base} statusCode={undefined} latencyMs={undefined} />);

		expect(screen.getByRole("button").querySelector("svg.text-destructive-text")).toBeNull();
	});

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
		const order = ["connect: timed out", "the-details", "Timing breakdown", "the-children"].map(
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

	it.each([
		[200, "success"],
		[301, "success"],
		[404, "error"],
		[429, "error"],
		[500, "error"],
		[0, "error"],
	] as const)("reads a %i with no error string as %s", (statusCode, expected) => {
		// The engine's error definition is 200-399 succeeds, anything else does
		// not (#2124), so a 4xx or 5xx must not wear the success tick.
		const { container } = render(<SampledExchange {...base} statusCode={statusCode} />);

		const error = container.querySelector(".text-destructive-text");
		const success = container.querySelector(".text-status-success-text");
		expect(error !== null).toBe(expected === "error");
		expect(success !== null).toBe(expected === "success");
	});

	it("lets a caller-supplied state win over the status code", () => {
		// A collection step can fail a test over a 200 and skip over nothing.
		const { container, rerender } = render(
			<SampledExchange {...base} statusCode={200} state="error" />
		);
		expect(container.querySelector(".text-destructive-text")).not.toBeNull();

		rerender(<SampledExchange {...base} statusCode={500} state="success" />);
		expect(container.querySelector(".text-destructive-text")).toBeNull();
		expect(container.querySelector(".text-status-success-text")).not.toBeNull();
	});

	it("marks a slow sample on both the icon and the latency", () => {
		const { container } = render(<SampledExchange {...base} isSlow />);

		expect(container.querySelectorAll(".text-status-stopped-text")).toHaveLength(2);
	});

	it("omits the timing heading when no phase was reported", () => {
		// The heading used to be gated separately from its content, so a trace
		// with only TTFB and download printed a heading over nothing.
		render(<SampledExchange {...base} isExpanded phases={phasesFromTrace({})} />);

		expect(screen.queryByText("Timing breakdown")).toBeNull();
	});

	it("squares off the row's own corners", () => {
		// Every caller renders this row full-bleed (a `divide-y` list or a
		// `border-b` strip), never inset - a rounded hover fill floating inside
		// the row's own square edges is what this overrides the Button
		// primitive's baseline `rounded-md` to avoid.
		render(<SampledExchange {...base} />);

		expect(screen.getByRole("button").className).toMatch(/\brounded-none\b/);
	});

	describe("the summary row's layout (#3495)", () => {
		/*
		 * jsdom has no layout, so each rule is held as the classes that make it.
		 * The row's fixed tracks are what lines a list's rows up; the container
		 * variants are what make it answer to the run pane, not the window.
		 */
		const classesOf = (el: Element | null) => (el?.getAttribute("class") ?? "").split(/\s+/);

		it("is a grid with fixed tracks for the label, status, latency and time", () => {
			render(<SampledExchange {...base} />);

			const row = classesOf(screen.getByRole("button"));
			expect(row).toContain("grid");
			expect(row).toContain(
				"@3xl:grid-cols-[auto_auto_3.5rem_minmax(0,1fr)_12rem_4.5rem_auto]"
			);
			// Each cell has its own track, so a row with no status leaves it empty.
			expect(classesOf(screen.getByText("200 OK"))).toContain("@3xl:col-start-5");
			expect(classesOf(screen.getByText(formatLatency(base.latencyMs)))).toContain(
				"@3xl:col-start-6"
			);
			expect(classesOf(screen.getByText("10:11:12.345"))).toContain("@3xl:col-start-7");
			// The group the three share dissolves into the grid at that width.
			expect(classesOf(screen.getByText("10:11:12.345").parentElement)).toContain(
				"@3xl:contents"
			);
		});

		it("answers to its own width: a @container root and no viewport variant", () => {
			const { container } = render(
				<SampledExchange {...base} title={<span>Create a customer</span>} error="x: y" />
			);

			expect(classesOf(container.firstElementChild)).toContain("@container");
			expect(container.innerHTML).not.toMatch(/[\s"]sm:/);
		});

		it("gives the caller's title a track that can shrink", () => {
			render(<SampledExchange {...base} title={<span>Create a customer</span>} />);

			const holder = screen.getByText("Create a customer").parentElement;
			expect(classesOf(holder)).toEqual(expect.arrayContaining(["min-w-0", "max-w-full"]));
			expect(classesOf(holder!.parentElement)).toContain("min-w-0");
		});

		it("truncates the error preview instead of cutting it at a fixed width", () => {
			render(<SampledExchange {...base} statusCode={500} error="connect: refused" />);

			const preview = screen.getByText("connect");
			expect(classesOf(preview)).toEqual(
				expect.arrayContaining(["block", "truncate", "min-w-0"])
			);
			expect(classesOf(preview).join(" ")).not.toMatch(/max-w-\[200px\]/);
		});

		it("draws no lead cell when there is neither a title nor an error", () => {
			const { container } = render(<SampledExchange {...base} />);

			expect(container.querySelector('[class~="@3xl:flex-nowrap"]')).toBeNull();
			// The group takes the lead's place on the first line instead of a second.
			expect(classesOf(screen.getByText("10:11:12.345").parentElement)).toEqual(
				expect.arrayContaining(["col-start-4", "row-start-1"])
			);
		});
	});
});
