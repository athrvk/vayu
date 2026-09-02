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
 * The field steers its own list, and says so (issue #1215).
 *
 * Two defects met here. The arrows were forwarded by building a synthetic
 * keydown and dispatching it at `document.querySelector("[cmdk-root]")`, and
 * Enter clicked `document.querySelector('[cmdk-item][data-selected="true"]')` -
 * the *document's* first cmdk list and its highlighted row, of which the app
 * mounts four. And the input carried no combobox semantics at all, so the
 * highlight those arrows moved was announced to nobody.
 *
 * The decoy below is the mutation check for the first: it is a real `Command`
 * root rendered ahead of the field, so a document-wide query finds it instead.
 * Restore either `document.querySelector` and "moves the highlight in its own
 * list" reds; drop the aria wiring and the semantics block does.
 */

import { describe, it, expect } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { Command, CommandList, CommandGroup, CommandItem, TooltipProvider } from "@/components/ui";
import { variableSupportStub } from "@/test/variable-support";
import type { ResolvedVariable } from "@/types";
import VariableInput from "./index";

const SCOPED: Record<string, ResolvedVariable> = {
	alpha: { value: "a", scope: "global" },
	beta: { value: "b", scope: "global" },
	gamma: { value: "c", scope: "global" },
};

/**
 * A second cmdk list, mounted *before* the field.
 *
 * Not a stub: `Command` is the same primitive `VariableAutocomplete` renders,
 * so `[cmdk-root]` and `[cmdk-item][data-selected="true"]` match it exactly as
 * they matched the real one. This is the arrangement the old code got wrong.
 */
function DecoyList() {
	return (
		<Command shouldFilter={false}>
			<CommandList>
				<CommandGroup heading="Decoy">
					<CommandItem value="decoy-one">decoy one</CommandItem>
					<CommandItem value="decoy-two">decoy two</CommandItem>
				</CommandGroup>
			</CommandList>
		</Command>
	);
}

interface HarnessProps {
	initial?: string;
	decoy?: boolean;
	scoped?: boolean;
	suggestions?: string[];
}

function Harness({ initial = "", decoy = false, scoped = true, suggestions }: HarnessProps) {
	const [value, setValue] = useState(initial);
	return (
		<TooltipProvider delayDuration={0}>
			{decoy && <DecoyList />}
			<VariableInput
				value={value}
				onChange={setValue}
				aria-label="URL"
				suggestions={suggestions}
				variables={scoped ? variableSupportStub(SCOPED) : undefined}
			/>
		</TooltipProvider>
	);
}

function renderHarness(props: HarnessProps = {}) {
	const utils = render(<Harness {...props} />);
	const input = screen.getByLabelText("URL") as HTMLInputElement;
	return { ...utils, input };
}

/** Type into the field the way the component's own handler sees it. */
function type(input: HTMLInputElement, text: string) {
	fireEvent.change(input, { target: { value: text } });
}

/** The rows of the field's own list - never the document's first one. */
function ownList(container: HTMLElement): HTMLElement {
	const lists = container.querySelectorAll<HTMLElement>("[cmdk-list]");
	// The decoy, when present, is first; the field's list is the last one.
	expect(lists.length).toBeGreaterThan(0);
	return lists[lists.length - 1];
}

function highlighted(list: HTMLElement): HTMLElement | null {
	return list.querySelector<HTMLElement>('[cmdk-item][data-selected="true"]');
}

describe("the suggestion list the arrows steer", () => {
	it("moves the highlight in its own list, with another cmdk root mounted first", () => {
		const { container, input } = renderHarness({ decoy: true });

		type(input, "{{");
		const list = ownList(container);
		expect(highlighted(list)).toHaveTextContent("alpha");

		fireEvent.keyDown(input, { key: "ArrowDown" });

		expect(highlighted(list)).toHaveTextContent("beta");
		// And the decoy was left alone: it kept whatever cmdk gave it, which is
		// its own first row, never the second.
		const decoy = container.querySelectorAll<HTMLElement>("[cmdk-list]")[0];
		expect(highlighted(decoy)).not.toHaveTextContent("decoy two");
	});

	it("clamps at the ends rather than wrapping, as cmdk's own default does", () => {
		const { container, input } = renderHarness();

		type(input, "{{");
		const list = ownList(container);
		fireEvent.keyDown(input, { key: "ArrowUp" });

		expect(highlighted(list)).toHaveTextContent("alpha");
	});

	it("inserts the highlighted row on Enter, not whatever the document highlighted", () => {
		const { input } = renderHarness({ decoy: true });

		type(input, "{{");
		fireEvent.keyDown(input, { key: "ArrowDown" });
		fireEvent.keyDown(input, { key: "Enter" });

		expect(input.value).toBe("{{beta}}");
	});

	it("leaves Enter alone when it carries the Send chord's modifier", () => {
		const { input } = renderHarness();

		type(input, "{{");
		fireEvent.keyDown(input, { key: "Enter", metaKey: true });

		// ⌘Enter sends the request; a field acting on it too is two actions from
		// one press (app/CLAUDE.md, #935).
		expect(input.value).toBe("{{");
	});

	it("navigates the plain suggestion list the same way", () => {
		const { input } = renderHarness({
			scoped: false,
			suggestions: ["Accept", "Accept-Encoding"],
		});

		fireEvent.focus(input);
		fireEvent.keyDown(input, { key: "ArrowDown" });
		fireEvent.keyDown(input, { key: "Enter" });

		expect(input.value).toBe("Accept-Encoding");
	});
});

describe("the field's combobox semantics", () => {
	it("names the open list and the row the arrows are on", () => {
		const { container, input } = renderHarness();

		expect(input).toHaveAttribute("role", "combobox");
		expect(input).toHaveAttribute("aria-autocomplete", "list");
		expect(input).toHaveAttribute("aria-expanded", "false");
		expect(input).not.toHaveAttribute("aria-activedescendant");

		type(input, "{{");
		const list = ownList(container);

		expect(input).toHaveAttribute("aria-expanded", "true");
		expect(input).toHaveAttribute("aria-controls", list.id);
		expect(list).toHaveAttribute("role", "listbox");
		expect(input.getAttribute("aria-activedescendant")).toBe(highlighted(list)?.id);

		fireEvent.keyDown(input, { key: "ArrowDown" });

		const moved = highlighted(list);
		expect(moved).toHaveTextContent("beta");
		expect(input.getAttribute("aria-activedescendant")).toBe(moved?.id);
	});

	it("tracks a highlight the pointer moved, not only one the arrows did", () => {
		/*
		 * cmdk moves its own highlight on `onPointerMove`, which re-renders the
		 * list and nothing above it. The probe is subscribed to cmdk's store
		 * rather than to this field's state for exactly that reason - read the
		 * highlight from the props going down and a hover would announce nothing.
		 */
		const { container, input } = renderHarness();

		type(input, "{{");
		const list = ownList(container);
		const rows = list.querySelectorAll<HTMLElement>("[cmdk-item]");
		fireEvent.pointerMove(rows[2]);

		expect(highlighted(list)).toHaveTextContent("gamma");
		expect(input.getAttribute("aria-activedescendant")).toBe(rows[2].id);
	});

	it("stays an ordinary text box where no list can ever open", () => {
		const { input } = renderHarness({ scoped: false });

		// No scope and no plain suggestions: promising a list a screen-reader
		// user then cannot find is worse than promising nothing.
		expect(input).not.toHaveAttribute("role");
		expect(input).not.toHaveAttribute("aria-expanded");
	});
});

/** Everything a keyboard can land on, by the rules a browser uses. */
function focusable(root: HTMLElement): HTMLElement[] {
	return Array.from(
		root.querySelectorAll<HTMLElement>(
			'a[href], button, input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
		)
	);
}

describe("the token overlay", () => {
	it("holds no focusable element inside an aria-hidden subtree", () => {
		const { container } = renderHarness({ initial: "{{alpha}}/{{$guid}}/{{nope}}" });

		const overlay = container.querySelector<HTMLElement>("[data-variable-overlay]");
		expect(overlay).toBeTruthy();
		expect(overlay).not.toHaveAttribute("aria-hidden");

		// The guard has to have scanned something, or it passes on an empty tree.
		const stops = focusable(overlay!);
		expect(stops.length).toBeGreaterThan(0);
		for (const el of stops) {
			expect(el.closest('[aria-hidden="true"]')).toBeNull();
		}
	});

	it("still hides the parts that only restate the input's own value", () => {
		const { container } = renderHarness({ initial: "a/{{$guid}}" });

		const overlay = container.querySelector<HTMLElement>("[data-variable-overlay]")!;
		// The literal text either side of a token, and a run-time token, which has
		// no popover to open and is not focusable.
		expect(within(overlay).getByText("a/")).toHaveAttribute("aria-hidden", "true");
		expect(overlay.querySelector("[data-runtime-token]")).toHaveAttribute(
			"aria-hidden",
			"true"
		);
	});
});

/** The editable tokens, in painted order. */
function tokens(container: HTMLElement): HTMLElement[] {
	return Array.from(
		container.querySelectorAll<HTMLElement>('[data-variable-token] [role="button"]')
	);
}

describe("the token strip", () => {
	it("is one Tab stop, however many variables the field holds", () => {
		const { container } = renderHarness({ initial: "{{alpha}}/{{beta}}/{{gamma}}" });

		const strip = tokens(container);
		expect(strip).toHaveLength(3);
		expect(strip.filter((t) => t.getAttribute("tabindex") === "0")).toHaveLength(1);
		expect(strip[0]).toHaveAttribute("tabindex", "0");
	});

	it("moves between tokens on the arrow keys, carrying the Tab stop", () => {
		const { container } = renderHarness({ initial: "{{alpha}}/{{beta}}/{{gamma}}" });

		const strip = tokens(container);
		strip[0].focus();
		fireEvent.keyDown(strip[0], { key: "ArrowRight" });

		expect(document.activeElement).toBe(tokens(container)[1]);
		expect(tokens(container)[1]).toHaveAttribute("tabindex", "0");
		expect(tokens(container)[0]).toHaveAttribute("tabindex", "-1");
	});

	it("does not wrap - arrowing off the end leaves Tab as the way out", () => {
		const { container } = renderHarness({ initial: "{{alpha}}/{{beta}}" });

		const strip = tokens(container);
		strip[0].focus();
		fireEvent.keyDown(strip[0], { key: "ArrowLeft" });

		expect(document.activeElement).toBe(strip[0]);
	});

	it("jumps to the last token on End and back on Home", () => {
		const { container } = renderHarness({ initial: "{{alpha}}/{{beta}}/{{gamma}}" });

		tokens(container)[0].focus();
		fireEvent.keyDown(tokens(container)[0], { key: "End" });
		expect(document.activeElement).toBe(tokens(container)[2]);

		fireEvent.keyDown(tokens(container)[2], { key: "Home" });
		expect(document.activeElement).toBe(tokens(container)[0]);
	});

	it("leaves the tab order entirely when the field is disabled", () => {
		const { container } = render(
			<TooltipProvider delayDuration={0}>
				<VariableInput
					value="{{alpha}}/{{beta}}"
					onChange={() => {}}
					aria-label="URL"
					disabled
					variables={variableSupportStub(SCOPED)}
				/>
			</TooltipProvider>
		);

		// The other half of "no focusable element under aria-hidden": a disabled
		// field paints the same strip, and it must not hold a stop at all.
		const strip = tokens(container);
		expect(strip).toHaveLength(2);
		expect(strip.every((t) => t.getAttribute("tabindex") === "-1")).toBe(true);
	});

	it("still opens the popover from the token that holds focus", () => {
		const { container } = renderHarness({ initial: "{{alpha}}/{{beta}}" });

		const strip = tokens(container);
		strip[0].focus();
		fireEvent.keyDown(strip[0], { key: "ArrowRight" });
		fireEvent.keyDown(tokens(container)[1], { key: "Enter" });

		expect(screen.getByRole("dialog")).toHaveTextContent("beta");
	});
});
