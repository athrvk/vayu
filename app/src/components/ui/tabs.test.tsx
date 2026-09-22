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
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { Tabs, TabsContent, TabsList, TabsTrigger, TabLabel, TabCount, TabErrorDot } from "./tabs";

/** Two triggers whose labels differ enough in width for a shift to show. */
function Fixture() {
	return (
		<Tabs defaultValue="one">
			<TabsList variant="bare">
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
				<TabsList variant="bare">
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
		// The value rides an inner span so `.enter-fade` still has a mount to
		// fire on; the slot it sits in is the `sup` and no longer unmounts.
		const el = screen.getByText("5").closest("sup")!;
		expect(el).not.toBeNull();
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

/*
 * The mark slot holds its width open (the Params-badge report).
 *
 * `TabCount` used to be gated at each call site (`badge !== undefined &&`) and
 * to return `null` at zero, so a count arriving *mounted a flex item* on a
 * `shrink-0` trigger inside a `flex-nowrap` list: the trigger grew by the mark
 * plus the trigger's own `gap-1.5`, and every trigger to its right - plus
 * whatever else shared the row - moved. Typing one character into an empty
 * Params table moved seven tabs and a toggle.
 *
 * jsdom lays nothing out, so the width itself is unobservable here (the same
 * limit TabLabel's tests hit). What is observable is the mechanism: the `sup`
 * is present in both states and carries the reserved-width class, and the
 * trigger's own class list does not change.
 *
 * Mutation check (confirmed): restore `if (value === undefined) return null;`
 * at the top of `TabCount` and "keeps the count's slot..." fails on the absent
 * `sup`; drop `min-w-[1ch]` from `MARK_SLOT` and "reserves exactly one digit"
 * and the error-dot case both fail.
 */
describe("a count appearing does not move the tabs beside it", () => {
	function Counted({ badge }: { badge?: number }) {
		return (
			<Tabs defaultValue="one">
				<TabsList variant="inset" className="flex-nowrap">
					<TabsTrigger value="one">
						<TabLabel>Params</TabLabel>
						<TabCount value={badge} />
					</TabsTrigger>
					<TabsTrigger value="two">
						<TabLabel>Headers</TabLabel>
					</TabsTrigger>
				</TabsList>
				<TabsContent value="one">one</TabsContent>
				<TabsContent value="two">two</TabsContent>
			</Tabs>
		);
	}

	const slotOf = (tab: HTMLElement) => tab.querySelector<HTMLElement>("[data-slot='tab-count']");

	it("keeps the count's slot in the DOM with nothing to count", () => {
		render(<Counted />);
		const slot = slotOf(screen.getByRole("tab", { name: "Params" }));
		expect(slot, "no slot - the count will widen the trigger when it arrives").not.toBeNull();
		expect(slot?.tagName).toBe("SUP");
	});

	it("reserves exactly one digit, in the count's own font", () => {
		render(<Counted badge={3} />);
		// `/Params/`, not `"Params"`: a count that is *showing* joins the
		// trigger's accessible name ("Params 3"), which is the behaviour this
		// file's other cases pin. Only the empty slot has to stay silent.
		const slot = slotOf(screen.getByRole("tab", { name: /Params/ }))!;
		// `ch` in `font-mono` `text-micro` is one digit of the count itself - a
		// px literal would drift the moment the micro step moved.
		expect(slot.className).toContain("min-w-[1ch]");
		expect(slot.className).toContain("font-mono");
		expect(slot.className).toContain("text-micro");
	});

	it("changes only the slot's contents when the count arrives", () => {
		const { rerender } = render(<Counted />);
		const params = screen.getByRole("tab", { name: "Params" });
		const headers = screen.getByRole("tab", { name: "Headers" });

		const emptySlot = slotOf(params)!;
		expect(emptySlot.textContent).toBe("");
		const triggerClasses = params.className;
		const slotClasses = emptySlot.className;

		rerender(<Counted badge={3} />);

		const filledSlot = slotOf(params)!;
		expect(params.className).toBe(triggerClasses);
		expect(filledSlot.textContent).toBe("3");
		// The same element, not a remount: only its child changed.
		expect(filledSlot).toBe(emptySlot);
		expect(filledSlot.className).toBe(slotClasses);
		expect(params.className).toBe(triggerClasses);
		// Nothing was inserted before Headers, which is how the shift travelled.
		expect(headers.querySelector("[data-slot='tab-count']")).toBeNull();
	});

	it("says nothing at all when there is nothing to count", () => {
		render(<Counted />);
		const params = screen.getByRole("tab", { name: "Params" });
		// An empty slot, not a `0` and not a placeholder glyph: it must reach
		// neither a screen reader nor the eye. `TabLabel` renders its label twice,
		// so `textContent` is "ParamsParams" and always will be - the claim is
		// that no digit joins it.
		expect(params.textContent).not.toMatch(/\d/);
		expect(screen.getByRole("tab", { name: "Params" })).toBeInTheDocument();
	});

	it("still swallows a zero rather than announcing 'there are none'", () => {
		render(<Counted badge={0} />);
		expect(slotOf(screen.getByRole("tab", { name: "Params" }))?.textContent).toBe("");
		expect(screen.getByRole("tab", { name: "Params" }).textContent).not.toMatch(/\d/);
	});

	it("gives the error dot the same slot, so the Console swap is width-neutral", () => {
		// The one call site renders the dot *instead of* the count. A bare 5px
		// dot standing where a 1ch count stood moves everything to its right.
		const { container } = render(<TabErrorDot />);
		const slot = container.querySelector<HTMLElement>("[data-slot='tab-error-dot']")!;
		expect(slot).not.toBeNull();
		expect(slot.className).toContain("min-w-[1ch]");
		expect(slot.className).toContain("text-micro");
		expect(slot.querySelector("[aria-label='Script error']")).not.toBeNull();
	});
});

/*
 * The strip's chrome (issue #1688). Seven call sites carried seven band
 * recipes; the variant is where they live now, and it is required so a new
 * strip states which of the three it is. Rendered rather than scanned: the
 * class list goes through `cn()`, and a scan cannot see what tailwind-merge
 * does to a caller's `className` on top of the variant.
 *
 * Mutation check (confirmed): swap `pane` and `inset` in VARIANT and both of
 * the first two cases fail.
 */
describe("TabsList variants", () => {
	function listFor(variant: "pane" | "inset" | "bare") {
		const { container } = render(
			<Tabs defaultValue="one">
				<TabsList variant={variant}>
					<TabsTrigger value="one">
						<TabLabel>One</TabLabel>
					</TabsTrigger>
				</TabsList>
				<TabsContent value="one">one</TabsContent>
			</Tabs>
		);
		const list = container.querySelector<HTMLElement>("[data-slot='tabs-list']")!;
		expect(list).not.toBeNull();
		return list;
	}

	it("draws the pane band: panel fill, the rule under it, and the pane's padding", () => {
		const list = listFor("pane");
		expect(list.className).toContain("bg-panel");
		expect(list.className).toContain("border-b");
		expect(list.className).toContain("border-rule");
		expect(list.className).toContain("px-4");
		expect(list.dataset.variant).toBe("pane");
	});

	it("insets only enough to keep the first trigger's ring off the edge", () => {
		const list = listFor("inset");
		expect(list.className).toContain("px-1");
		// No band: the content around it already carries the chrome.
		expect(list.className).not.toContain("bg-panel");
		expect(list.className).not.toContain("border-b");
	});

	it("adds nothing at all when the parent row owns the band", () => {
		const list = listFor("bare");
		expect(list.className).not.toContain("bg-panel");
		expect(list.className).not.toContain("border-b");
		expect(list.className).not.toContain("px-4");
		expect(list.className).not.toContain("px-1");
	});

	it("lets a call site keep its own layout classes beside the variant", () => {
		const { container } = render(
			<Tabs defaultValue="one">
				<TabsList variant="pane" className="shrink-0 justify-start">
					<TabsTrigger value="one">
						<TabLabel>One</TabLabel>
					</TabsTrigger>
				</TabsList>
				<TabsContent value="one">one</TabsContent>
			</Tabs>
		);
		const list = container.querySelector<HTMLElement>("[data-slot='tabs-list']")!;
		expect(list.className).toContain("bg-panel");
		expect(list.className).toContain("shrink-0");
		expect(list.className).toContain("justify-start");
	});
});

/*
 * Every strip in the app states its chrome.
 *
 * Source-scanned on purpose, and this is the one claim a render cannot make:
 * it is about the call sites, not about the primitive. The tag is matched
 * across newlines because prettier breaks a multi-attribute JSX tag onto one
 * line per attribute, so a single-line grep reports three false positives
 * (`ResponseViewer`, `RequestTabs`, `CollectionDetail`) that do carry the prop.
 */
describe("every TabsList call site declares its variant", () => {
	const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
	const files = globSync("**/*.tsx", { cwd: srcRoot }).filter((f) => !f.includes(".test."));

	it("scans a real tree", () => {
		expect(files.length).toBeGreaterThan(100);
	});

	it("finds a variant inside every opening tag", () => {
		const tags: [file: string, tag: string][] = [];
		for (const file of files) {
			const source = readFileSync(join(srcRoot, file), "utf8");
			for (const m of source.matchAll(/<TabsList\b[\s\S]*?>/g)) {
				tags.push([relative(".", file), m[0]]);
			}
		}
		// The seven strips this issue converted. A drop below that is a strip
		// deleted or a scan that stopped seeing them.
		expect(
			tags.length,
			"no TabsList call sites found - has the scan broken?"
		).toBeGreaterThanOrEqual(7);
		for (const [file, tag] of tags) {
			expect(tag, `${file} renders a TabsList with no variant`).toMatch(/variant=/);
		}
	});
});
