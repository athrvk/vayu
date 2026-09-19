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
 * `DisabledHint` reaches its reason on both paths a disabled control closes.
 *
 * The hover half cannot be driven here: jsdom has no hit testing, so a
 * `pointer-events` value changes nothing it will report and `userEvent.hover`
 * would fire on the span whether or not a browser could have reached it. So the
 * class is what this asserts - it is the whole mechanism, and removing it is
 * exactly the regression a rendered assertion catches (mutation check: drop
 * `pointer-events-auto` from the wrapper and the first case fails). The focus
 * half is real: the wrapper's own tab stop is asserted, and the tooltip content
 * is driven through it. `user-event` is not a dependency here, so focus is moved
 * the way Radix listens for it, the shape `TabStrip.keyboard.test.tsx` uses.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { DisabledHint } from "./disabled-hint";
import { Button } from "./button";
import { TooltipProvider } from "./tooltip";

afterEach(cleanup);

function renderHint(reason: string | false) {
	return render(
		<TooltipProvider delayDuration={0}>
			<DisabledHint reason={reason}>
				<Button disabled={Boolean(reason)}>Clear</Button>
			</DisabledHint>
		</TooltipProvider>
	);
}

/** The wrapper, found the way a caller's own test would have to find it. */
function wrapper(): HTMLElement {
	const el = document.querySelector<HTMLElement>('[data-slot="disabled-hint"]');
	expect(el, "the gated control rendered no hint wrapper").not.toBeNull();
	return el as HTMLElement;
}

describe("DisabledHint", () => {
	it("keeps its own pointer events, which the disabled child has given up", () => {
		renderHint("No captures to clear");

		// Both halves of the pair, in the one order that matters: the child is
		// what refuses the click, the wrapper is what still hears the pointer.
		expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
		expect(wrapper().className).toContain("pointer-events-auto");
	});

	it("is a tab stop, so a keyboard user reaches the reason too", () => {
		renderHint("No captures to clear");

		expect(wrapper().tabIndex).toBe(0);
	});

	it("shows the reason on focus", async () => {
		renderHint("No captures to clear");

		const el = wrapper();
		el.focus();
		fireEvent.focus(el);

		expect(el).toHaveFocus();
		// Radix renders the content twice while open - the visible tooltip and the
		// hidden copy it names the trigger with - so this asserts at least one.
		await waitFor(() => {
			expect(screen.getAllByText("No captures to clear").length).toBeGreaterThan(0);
		});
	});

	it("adds nothing when the control is not gated", () => {
		renderHint(false);

		expect(document.querySelector('[data-slot="disabled-hint"]')).toBeNull();
		expect(screen.getByRole("button", { name: "Clear" })).toBeEnabled();
	});
});
