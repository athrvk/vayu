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
 * The command list's chrome: the surface it declares, the dividers that read on
 * it, its row density, and who draws a section label (#1177).
 *
 * The surface half is the `--rule` contract these guards exist for, as in
 * `ImportModal.surface-rule.test.tsx`: what is pinned is the *declaration*, not
 * the `border-rule` classes, because a `border-rule` under no declared surface
 * silently falls back to the `:root` default - which on a card is invisible in
 * dark, and is exactly the state this tree was in. jsdom cannot resolve the
 * colour; that was measured in the browser.
 *
 * The density half is a rendered class read, not a source scan, per the rule in
 * `app/CLAUDE.md`: the row padding arrives through a descendant selector on the
 * dialog's `Command` root, which no scan of the item would ever see. At 44px
 * rows a 300px list showed about six of them, so a section past the second was
 * below the fold with nothing on screen saying so.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import {
	CommandDialog,
	CommandFooter,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "./command";

/** Exact class tokens, safe for SVG nodes whose className is not a string. */
function tokens(el: Element): string[] {
	return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

function renderPalette() {
	render(
		<CommandDialog open title="Command palette" description="Search everything.">
			<CommandInput placeholder="Search…" />
			<CommandList>
				<CommandGroup heading="Tabs">
					<CommandItem value="inbox">Inbox</CommandItem>
				</CommandGroup>
				<CommandSeparator />
				<CommandGroup heading="Settings">
					<CommandItem value="theme">Theme Mode</CommandItem>
				</CommandGroup>
			</CommandList>
			<CommandFooter>
				<span>navigate</span>
			</CommandFooter>
		</CommandDialog>
	);
	const root = document.querySelector('[data-slot="command"]');
	expect(root, "the command root should render").toBeTruthy();
	return root as HTMLElement;
}

/** Every element in the tree, root included - what each scan below reads. */
function everything(root: HTMLElement): Element[] {
	return [root, ...Array.from(root.querySelectorAll("*"))];
}

describe("the command list's surface and its dividers", () => {
	it("pairs bg-card with surface-card on the root - both halves load-bearing", () => {
		const cls = tokens(renderPalette());
		// surface-card declares the --rule every divider below here inherits.
		expect(cls).toContain("surface-card");
		// bg-card is what tailwind-merge can strip a background utility with;
		// the surface class lives in @layer components and would lose to one.
		expect(cls).toContain("bg-card");
		// The token it replaced. --popover and --card are the same three numbers
		// in both themes, so this is a rename - but only one of them declares.
		expect(cls).not.toContain("bg-popover");
	});

	it("draws no divider with a token the surface cannot resolve", () => {
		const root = renderPalette();
		const scanned = everything(root);
		// The scan has to be reading a real tree, or it passes forever: input
		// wrapper, list, two groups, two rows, separator, footer and more.
		expect(scanned.length).toBeGreaterThan(8);
		const offenders = scanned
			.filter((el) => {
				const cls = tokens(el);
				return cls.includes("bg-border") || cls.includes("border-border");
			})
			.map((el) => el.getAttribute("class") ?? "");
		expect(offenders).toEqual([]);
	});

	it("rules the three dividers the palette actually draws", () => {
		const root = renderPalette();
		const dividers = [
			root.querySelector("[cmdk-input-wrapper]"),
			root.querySelector('[data-slot="command-separator"]'),
			document.querySelector('[data-slot="command-footer"]'),
		];
		for (const divider of dividers) {
			expect(divider, "every band this asserts should be on screen").toBeTruthy();
			expect(tokens(divider!)).toContain("border-rule");
		}
	});
});

describe("the command list's density", () => {
	it("draws rows at py-2, the launcher metric, not the shadcn py-3", () => {
		const cls = tokens(renderPalette());
		// The padding reaches the rows through a descendant selector here, so
		// this is where it can be read - the item itself carries neither value.
		expect(cls).toContain("[&_[cmdk-item]]:py-2");
		expect(cls).not.toContain("[&_[cmdk-item]]:py-3");
	});
});

describe("a section label", () => {
	it("is the app's Eyebrow, not a third spelling of its class string", () => {
		renderPalette();
		const headings = [...document.querySelectorAll("[cmdk-group-heading]")];
		expect(headings).toHaveLength(2);
		for (const heading of headings) {
			expect(heading.querySelector('p[data-slot="eyebrow"]')).toBeTruthy();
			// The wrapper cmdk labels the group by keeps its text, so every
			// heading query - and every `aria-labelledby` - still resolves.
			expect(heading.textContent).toMatch(/^(Tabs|Settings)$/);
		}
		expect(screen.getByText("Settings").closest("[cmdk-group]")).toBeTruthy();
	});

	it("leaves a caller's own node alone, rather than nesting it in a <p>", () => {
		render(
			<CommandDialog open title="Palette" description="Search.">
				<CommandList>
					<CommandGroup heading={<div data-testid="own-heading">Runs</div>}>
						<CommandItem value="r1">A run</CommandItem>
					</CommandGroup>
				</CommandList>
			</CommandDialog>
		);
		const own = screen.getByTestId("own-heading");
		expect(own.closest('[data-slot="eyebrow"]')).toBeNull();
	});
});
