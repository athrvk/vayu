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
 * The tab primitive's two load-bearing behaviours.
 *
 * Both are rendered rather than source-scanned. A scan cannot see either: the
 * width reservation is a layout effect of an element that carries no
 * distinguishing class, and the active colour arrives through a `data-[state=]`
 * variant that only exists once Radix has decided which trigger is selected.
 */

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Tabs, TabsContent, TabsList, TabsTrigger, TabLabel, TabCount, TabErrorDot } from "./tabs";

/** Two triggers whose labels differ enough in width for a shift to show. */
function Fixture() {
	return (
		<Tabs defaultValue="one">
			<TabsList>
				<TabsTrigger value="one">
					<TabLabel>Post-request</TabLabel>
				</TabsTrigger>
				<TabsTrigger value="two">
					<TabLabel>Variables</TabLabel>
				</TabsTrigger>
			</TabsList>
			<TabsContent value="one">one</TabsContent>
			<TabsContent value="two">two</TabsContent>
		</Tabs>
	);
}

/*
 * jsdom does not lay text out, so `getBoundingClientRect` is 0 for everything
 * and a real width comparison is impossible here. What *is* observable is the
 * mechanism: TabLabel renders a second, hidden copy of the label at the weight
 * the active state uses, and that copy is what holds the box open. Assert the
 * mechanism is present and correct, and assert the property it exists to
 * protect - that activation changes no layout-affecting class on the trigger.
 */
describe("TabLabel reserves the active width", () => {
	it("renders a hidden bold twin of the label", () => {
		render(<TabLabel>Variables</TabLabel>);
		const twin = document.querySelector("[data-slot='tab-label-reserve']");
		expect(twin, "no reservation element - neighbours will shift on activate").not.toBeNull();
		expect(twin).toHaveTextContent("Variables");
		expect(twin?.className).toContain("font-semibold");
		expect(twin?.className).toContain("invisible");
		expect(twin?.getAttribute("aria-hidden")).toBe("true");
	});

	it("keeps the twin out of the accessible name", () => {
		render(<Fixture />);
		// "Post-requestPost-request" would mean the hidden copy is being read.
		expect(screen.getByRole("tab", { name: "Post-request" })).toBeInTheDocument();
	});

	it("changes no width-affecting class when a trigger activates", () => {
		render(<Fixture />);
		const first = screen.getByRole("tab", { name: "Post-request" });
		const before = first.className;

		// Radix activates a trigger on mousedown, not click.
		fireEvent.mouseDown(screen.getByRole("tab", { name: "Variables" }), { button: 0 });

		// The weight change is expressed as a `data-[state=active]:` variant, so
		// the class list itself is identical in both states - only the attribute
		// moves. A trigger that swapped classes here would resize.
		expect(first.className).toBe(before);
		expect(first.getAttribute("data-state")).toBe("inactive");
	});
});

describe("ghost trigger colours", () => {
	it("paints the active label with --primary-text, not --primary", () => {
		render(<Fixture />);
		const trigger = screen.getByRole("tab", { name: "Post-request" });

		// --primary and --muted-foreground sit within ~1.04 of each other in the
		// default scheme, and graphite has no saturation to separate them at all.
		expect(trigger.className).toContain("data-[state=active]:text-primary-text");
		expect(trigger.className).not.toMatch(/data-\[state=active\]:text-primary(?!-text)/);
		expect(trigger.className).toContain("data-[state=active]:font-semibold");
		expect(trigger.className).toContain("text-muted-foreground");

		// Radix activates a trigger on mousedown, not click.
		fireEvent.mouseDown(screen.getByRole("tab", { name: "Variables" }), { button: 0 });
		expect(screen.getByRole("tab", { name: "Variables" })).toHaveAttribute(
			"data-state",
			"active"
		);
	});

	it("carries a radius token so the Roundedness setting reaches it", () => {
		render(<Fixture />);
		// A bare `rounded`, or no radius class at all, both pin the box - see
		// radius-token.test.tsx and boxed-surfaces.test.tsx.
		expect(screen.getByRole("tab", { name: "Variables" }).className).toMatch(/\brounded-sm\b/);
	});

	it("gives the list no rule or fill of its own", () => {
		render(<Fixture />);
		const list = screen.getByRole("tablist");
		expect(list.className).not.toMatch(/\bborder-b\b/);
		expect(list.className).not.toMatch(/\bbg-muted\b/);
	});
});

describe("counts and the error mark are different things", () => {
	it("renders a count as an accent superscript that sets no height floor", () => {
		render(<TabCount value={5} />);
		const el = screen.getByText("5");
		expect(el.tagName).toBe("SUP");
		expect(el.className).toContain("text-primary-text");
		// An h-5 Badge pill is what kept the old band at 38px.
		expect(el.className).not.toMatch(/\bh-\d/);
	});

	it("renders the error mark independently of any count", () => {
		// The Console tab drew its script-error state in the count slot, so
		// count="none" would have deleted the only marker that a script failed.
		render(<TabErrorDot />);
		const dot = screen.getByLabelText("Script error");
		expect(dot.className).toContain("bg-status-error");
		expect(dot.className).not.toContain("text-primary-text");
	});
});
