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
 * The tab primitive's load-bearing behaviours.
 *
 * All are rendered rather than source-scanned. A scan cannot see any of them:
 * the width reservation is a layout effect of an element that carries no
 * distinguishing class, and both the active colour and the force-mounted
 * panel's hiding arrive through `data-[state=]` variants that only exist once
 * Radix has decided which trigger is selected.
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

	it("marks the active tab with a shape, not only a colour", () => {
		render(<Fixture />);
		const trigger = screen.getByRole("tab", { name: "Variables" });

		/*
		 * Colour and weight alone are not enough. Graphite's accent is a neutral,
		 * so its active label differs from an inactive one in lightness only, and
		 * 12px at 600 against 500 is a difference you have to hunt for - which is
		 * exactly the report that put this indicator here. A rule is a shape, and
		 * no accent scheme can wash a shape out.
		 */
		expect(trigger.className).toContain("data-[state=active]:after:bg-primary");
		// --primary, not --primary-text: this is an indicator, not a label.
		expect(trigger.className).not.toContain("after:bg-primary-text");
		// Absolutely positioned, so the band stays 24px rather than growing by 2.
		expect(trigger.className).toContain("after:absolute");
		expect(trigger.className).toContain("relative");
	});

	it("gives the list no rule or fill of its own", () => {
		render(<Fixture />);
		const list = screen.getByRole("tablist");
		expect(list.className).not.toMatch(/\bborder-b\b/);
		expect(list.className).not.toMatch(/\bbg-muted\b/);
	});

	it("draws the focus ring inside the trigger, where nothing can clip it", () => {
		render(<Fixture />);
		const trigger = screen.getByRole("tab", { name: "Variables" });

		/*
		 * A trigger fills its list's height exactly - measured in the running
		 * app, both boxes were 74->98 - and the three scrolling lists (response
		 * viewer, request builder, Collection Detail) are `overflow-x-auto
		 * overflow-y-hidden`, which clips. So an outward `ring-2` had no room at
		 * the top or the bottom and rendered as two cut-off vertical strokes.
		 *
		 * `ring-inset` is the fix that cannot be undone from a call site, which
		 * matters because the clipping lives on the *list* and the ring on the
		 * *trigger*: padding the lists would fix it three times and stay fixed
		 * only until the fourth scrolling tab strip.
		 */
		expect(trigger.className).toContain("focus-visible:ring-2");
		expect(trigger.className, "an outward ring is clipped by a scrolling tab strip").toContain(
			"focus-visible:ring-inset"
		);
	});
});

describe("a force-mounted panel stays out of sight", () => {
	/*
	 * Radix's `forceMount` means "always present", not "present but hidden":
	 * `present` becomes `forceMount || isSelected`, and the panel's `hidden`
	 * attribute is `!present` - so a force-mounted inactive panel renders with
	 * no `hidden` at all. Collection Detail force-mounts its four draft-holding
	 * panels to keep unsaved work alive, and every one of them was painted on
	 * top of whichever tab the user had actually selected.
	 *
	 * Hiding is the primitive's job, for the same reason TabLabel's width
	 * reservation is: a call site that reaches for `forceMount` is thinking
	 * about the draft it is saving, not about Radix's presence model.
	 */
	function Forced() {
		return (
			<Tabs defaultValue="two">
				<TabsList>
					<TabsTrigger value="one">
						<TabLabel>One</TabLabel>
					</TabsTrigger>
					<TabsTrigger value="two">
						<TabLabel>Two</TabLabel>
					</TabsTrigger>
				</TabsList>
				<TabsContent value="one" forceMount>
					one
				</TabsContent>
				<TabsContent value="two">two</TabsContent>
			</Tabs>
		);
	}

	it("keeps the inactive panel mounted", () => {
		render(<Forced />);
		// The whole point of force-mounting: the draft is still there.
		expect(screen.getByText("one")).toBeInTheDocument();
	});

	it("hides it on data-state, since Radix leaves off `hidden`", () => {
		render(<Forced />);
		const inactive = screen.getByText("one");

		expect(inactive).toHaveAttribute("data-state", "inactive");
		// Radix's own mechanism is absent here - this is the gap being filled.
		expect(inactive).not.toHaveAttribute("hidden");
		// jsdom applies no Tailwind, so the class list is the observable.
		expect(inactive.className, "a force-mounted panel renders over the active one").toContain(
			"data-[state=inactive]:hidden"
		);
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
