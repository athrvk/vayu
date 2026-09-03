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
 * A run-time token's tooltip has to be reachable, and the caret it used to let
 * through has to survive that (issue #604).
 *
 * The overlay paints with `pointer-events: none` so clicks fall through to the
 * transparent input underneath and place the caret. `EditableVariable`'s wrapper
 * re-enables them because it has a popover to open; `RuntimeToken`'s did not -
 * so neither `{{$guid}}` nor `{{data.email}}` ever received a pointer event, and
 * the Radix tooltip that is the token's *entire* content could never open. It
 * had been in that state since the generator token was added.
 *
 * **Why the pointer-events assertion is spelled out rather than implied by the
 * hover.** `userEvent` refuses to hover through an inherited
 * `pointer-events: none` and would fail on the unfixed component by itself, but
 * it is not a dependency of this app and adding one is not this fix's call.
 * `fireEvent` dispatches whatever it is told to, CSS notwithstanding - so a
 * hover test alone would pass on the broken component and prove nothing. The
 * pair restores the mutation check: drop the inline style and the first test
 * here fails; break the wiring and the rest do.
 */

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { variableSupportStub } from "@/test/variable-support";
import VariableInput from "./index";

function renderInput(value: string, columns?: string[]) {
	const scope = variableSupportStub(
		{ merchantId: { value: "m_1", scope: "global" } },
		columns
			? { dataColumns: { collectionId: "col-orders", collectionName: "Orders", columns } }
			: {}
	);
	const utils = render(
		<TooltipProvider delayDuration={0}>
			<VariableInput value={value} onChange={() => {}} aria-label="URL" variables={scope} />
		</TooltipProvider>
	);
	const input = screen.getByLabelText("URL") as HTMLInputElement;
	return { ...utils, input };
}

/** The wrapper that owns the pointer events, for the nth run-time token. */
function runtimeToken(container: HTMLElement, index = 0): HTMLElement {
	const tokens = container.querySelectorAll<HTMLElement>("[data-runtime-token]");
	expect(tokens.length).toBeGreaterThan(index);
	return tokens[index];
}

/** The trigger inside the wrapper - what Radix listens on, and what focuses. */
function trigger(token: HTMLElement): HTMLElement {
	return (token.firstElementChild as HTMLElement | null) ?? token;
}

/** The hover Radix actually listens for on a tooltip trigger. */
function hover(token: HTMLElement) {
	fireEvent.pointerMove(trigger(token), { pointerType: "mouse" });
}

/** Focus the nth run-time token the way a Tab or an arrow key would, and return it. */
function focusToken(container: HTMLElement, index = 0): HTMLElement {
	const el = trigger(runtimeToken(container, index));
	el.focus();
	return el;
}

/**
 * jsdom has no layout, so every rect is zero and "which half was clicked" has
 * no answer of its own. Give the token a box, then click a point inside it.
 */
function stubBox(token: HTMLElement, left: number, width: number) {
	token.getBoundingClientRect = () =>
		({
			left,
			width,
			right: left + width,
			top: 0,
			bottom: 0,
			height: 0,
			x: left,
			y: 0,
		}) as DOMRect;
}

describe("a run-time token", () => {
	it("receives pointer events, which is what makes its tooltip reachable at all", () => {
		const { container } = renderInput("https://x/y?id={{$guid}}");

		// The overlay stays transparent to the pointer; only the token opts back in.
		const overlay = container.querySelector<HTMLElement>("[data-variable-overlay]");
		expect(overlay?.style.pointerEvents).toBe("none");
		expect(runtimeToken(container).style.pointerEvents).toBe("auto");
	});
});

describe("a run-time token's tooltip", () => {
	it("opens on hover for a generator", async () => {
		const { container } = renderInput("https://x/y?id={{$guid}}");

		hover(runtimeToken(container));

		expect(await screen.findByRole("tooltip")).toHaveTextContent("generated per use");
	});

	it("opens on hover for a data column, carrying the declared contract", async () => {
		const { container } = renderInput("https://x/{{data.email}}", ["email"]);

		hover(runtimeToken(container));

		const tooltip = await screen.findByRole("tooltip");
		expect(tooltip).toHaveTextContent("Data column - bound per iteration");
		expect(tooltip).toHaveTextContent("declared in Orders");
	});

	it("names what is declared when the column is not in the contract", async () => {
		const { container } = renderInput("https://x/{{data.emial}}", ["email"]);

		hover(runtimeToken(container));

		expect(await screen.findByRole("tooltip")).toHaveTextContent("declared: email");
	});

	it("stacks the description above a declared list of any length", async () => {
		/*
		 * Issue #1195, and this tooltip is the sharper case: the note is the
		 * user's own column list, so it is unbounded, and beside a `break-all`
		 * description a note that refused to shrink took the whole 320px cap.
		 * jsdom cannot measure, so the class contract that decides the layout is
		 * what is pinned - restore the one-row shape and this reds.
		 */
		const columns = ["customer_email_address", "shipping_postal_code", "order_reference"];
		const { container } = renderInput("https://x/{{data.emial}}", columns);

		hover(runtimeToken(container));

		const tooltip = await screen.findByRole("tooltip");
		const note = tooltip.querySelector(`[class*="text-primary-foreground/"]`);
		expect(note).toBeTruthy();
		expect(note!.textContent).toContain(columns.join(", "));
		expect(note!.className).not.toContain("shrink-0");
		expect(note!.parentElement?.className).toContain("flex-col");
		// And the description above it still wraps mid-token: a column name is
		// one unbroken word, so without this it widens the tooltip instead.
		const description = note!.previousElementSibling;
		expect(description?.textContent).toContain("Not a declared column of");
		expect(description?.className).toContain("break-all");
	});

	/*
	 * Issue #1238. Every case above reaches this tooltip with a pointer, and it
	 * is the token's *entire* content - the generator's description, "not
	 * generated here" for an identity, and the amber "Not a declared column of
	 * ..." that is how a drifted contract is spotted at all.
	 *
	 * **The stop is asserted as an attribute, not as `document.activeElement`
	 * after a `focus()`.** jsdom decides focusability off the *presence* of a
	 * `contenteditable` attribute, never its value - and this span carries
	 * `contenteditable="false"`, so `focus()` lands on the unfixed component too
	 * and would measure nothing (the same trap as the `fireEvent` hover the
	 * header describes, one layer down). A browser goes by the tabindex; so does
	 * the first test here, which is the one that reds when the fix is reverted.
	 * The two below it are the behaviour that stop buys.
	 */
	it("carries the Tab stop that lets focus reach it at all", () => {
		const { container } = renderInput("https://x/y?id={{$guid}}");

		expect(trigger(runtimeToken(container))).toHaveAttribute("tabindex", "0");
	});

	it("opens on focus, so the description is not mouse-only", async () => {
		const { container } = renderInput("https://x/y?id={{$guid}}");

		focusToken(container);

		expect(await screen.findByRole("tooltip")).toHaveTextContent("generated per use");
	});

	it("opens on focus for an undeclared column, which is the warning nothing else states", async () => {
		const { container } = renderInput("https://x/{{data.emial}}", ["email"]);

		focusToken(container);

		const tooltip = await screen.findByRole("tooltip");
		expect(tooltip).toHaveTextContent("Not a declared column of");
		expect(tooltip).toHaveTextContent("declared: email");
	});

	it("is described by the tooltip it opened, rather than merely painting one", async () => {
		const { container } = renderInput("https://x/y?id={{$guid}}");

		const token = focusToken(container);

		// Radix wires `aria-describedby` through `asChild`; a span it cannot
		// focus never gets there, which is the whole of the old defect.
		const tooltip = await screen.findByRole("tooltip");
		expect(token.getAttribute("aria-describedby")).toBe(tooltip.getAttribute("id"));
	});
});

describe("clicking a run-time token", () => {
	it("puts the caret before it when the left half is clicked", () => {
		const { container, input } = renderInput("ab{{$guid}}cd");
		const token = runtimeToken(container);
		stubBox(token, 100, 40);

		fireEvent.click(token, { clientX: 105 });

		// "ab" is two characters, so the token starts at 2.
		expect(input.selectionStart).toBe(2);
		expect(document.activeElement).toBe(input);
	});

	it("puts the caret after it when the right half is clicked", () => {
		const { container, input } = renderInput("ab{{$guid}}cd");
		const token = runtimeToken(container);
		stubBox(token, 100, 40);

		fireEvent.click(token, { clientX: 135 });

		// `{{$guid}}` is nine characters: 2 + 9.
		expect(input.selectionStart).toBe(11);
	});

	it("counts from the token's own place in the value, not from the first one", () => {
		const { container, input } = renderInput("{{$guid}}-{{$timestamp}}");
		const second = runtimeToken(container, 1);
		stubBox(second, 200, 40);

		fireEvent.click(second, { clientX: 205 });

		// `{{$guid}}-` is ten characters.
		expect(input.selectionStart).toBe(10);
	});
});

describe("an editable token", () => {
	it("is not treated as a run-time one - its popover still owns the click", () => {
		const { container, input } = renderInput("{{merchantId}}");
		expect(container.querySelector("[data-runtime-token]")).toBeNull();

		const token = container.querySelector<HTMLElement>("[data-variable-token]");
		expect(token).toBeTruthy();
		fireEvent.click(token!);

		// The container's click handler must not pull focus into the input
		// behind a token that opened something of its own.
		expect(document.activeElement).not.toBe(input);
	});
});
