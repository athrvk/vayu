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

/** The hover Radix actually listens for on a tooltip trigger. */
function hover(token: HTMLElement) {
	const trigger = token.firstElementChild ?? token;
	fireEvent.pointerMove(trigger, { pointerType: "mouse" });
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
		const overlay = container.querySelector<HTMLElement>('[aria-hidden="true"]');
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
