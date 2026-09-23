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
 * Hovering a `{{token}}` now opens the same, full popover a click used to -
 * just inert, so resting the pointer never steals focus or risks an edit
 * (issue #1220 hover redesign). A click places a caret instead
 * (`VariableInput/index.tsx` owns that half - not exercised here, since this
 * component has no real `<input>` of its own to place one in); Enter/Space
 * opens the popover focused, for a keyboard user who has no hover state at
 * all.
 *
 * jsdom fires no real pointer events, so every hover here is a direct
 * `fireEvent.mouseEnter`/`mouseLeave` on the token's own stable wrapper, and
 * the open debounce and the leave-grace are both driven by fake timers.
 *
 * **The risk this redesign introduces is the reason for this file.**
 * `varInfo.secret` gates the popover's value behind a deliberate reveal, and a
 * hover that opened the real, editable-looking popover has to still respect
 * that gate - so the secret path is asserted in both directions: masked on an
 * ordinary hover, and never written to on a hover that merely came and went.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { TIMING } from "@/config/timing";
import { variableSupportStub } from "@/test/variable-support";

const { default: EditableVariable } = await import("./EditableVariable");

function renderToken(props: Partial<React.ComponentProps<typeof EditableVariable>> = {}) {
	return render(
		<TooltipProvider>
			<EditableVariable
				name="merchantId"
				value="mrc_8813"
				scope="environment"
				resolved
				sourceName="Staging"
				variables={variableSupportStub()}
				onValueChange={vi.fn()}
				{...props}
			/>
		</TooltipProvider>
	);
}

/** The token's own trigger span - what hover is tracked on, and the component's root. */
function wrapperOf(container: HTMLElement): HTMLElement {
	return container.firstElementChild as HTMLElement;
}

/** Where `VariablePopover` renders its content - see `variable-popover.tsx`. */
function popoverContent(): HTMLElement {
	const content = document.querySelector<HTMLElement>('[data-slot="popover-content"]');
	if (!content) throw new Error("no popover content on screen");
	return content;
}

/** Hover the token and let the open debounce run out. */
function hover(container: HTMLElement) {
	fireEvent.mouseEnter(wrapperOf(container));
	act(() => vi.advanceTimersByTime(TIMING.TOOLTIP_DELAY_MS));
}

/** Leave the token, without waiting the close grace out. */
function leave(container: HTMLElement) {
	fireEvent.mouseLeave(wrapperOf(container));
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("hovering an editable token", () => {
	it("opens the real popover, not a lightweight tooltip", () => {
		const { container } = renderToken();
		hover(container);
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByDisplayValue("mrc_8813")).toBeInTheDocument();
		expect(within(dialog).getByText("Staging")).toBeInTheDocument();
	});

	it("opens inert - nothing is focused, so the caret is never stolen", () => {
		const { container } = renderToken();
		hover(container);
		const dialog = screen.getByRole("dialog");
		expect(dialog.contains(document.activeElement)).toBe(false);
	});

	it("waits the debounce out, so a sweep across the field opens nothing", () => {
		const { container } = renderToken();
		fireEvent.mouseEnter(wrapperOf(container));
		act(() => vi.advanceTimersByTime(TIMING.TOOLTIP_DELAY_MS - 1));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("says so when the variable does not resolve", () => {
		const { container } = renderToken({ resolved: false, value: "", sourceName: undefined });
		hover(container);
		expect(screen.getByRole("dialog")).toHaveTextContent("Variable not defined");
	});

	it("distinguishes a defined-but-empty variable from an undefined one", () => {
		// Read-only (no `onValueChange`): an editable field showing "" just
		// looks blank, and "empty" is the read-only branch's own placeholder
		// for exactly that case (`variable-popover.tsx`).
		const { container } = renderToken({ value: "", onValueChange: undefined });
		hover(container);
		expect(screen.getByRole("dialog")).toHaveTextContent("empty");
		expect(screen.queryByText("Variable not defined")).not.toBeInTheDocument();
	});

	it("masks a secret exactly as a keyboard-opened popover would", () => {
		const { container } = renderToken({ secret: true, value: "sk_live_abcdef" });
		hover(container);
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByDisplayValue("••••••••")).toBeInTheDocument();
		expect(document.body.textContent).not.toContain("sk_live_abcdef");
	});
});

/**
 * Issue #1064. A bound row's column answers a bare name above every scope,
 * and the popover already says so for a click - a hover-opened instance is
 * the same component, so it has to say the same thing.
 */
describe("a bound row's column, on hover", () => {
	const withRow = variableSupportStub(
		{},
		{
			getVariableOrigins: () => [
				{
					scope: "environment",
					sourceName: "Staging",
					value: "staging@acme.io",
					enabled: true,
					winner: false,
				},
				{ scope: "row", value: "alice@acme.io", enabled: true, winner: true },
			],
		}
	);

	it("names the row rather than the definition it beat", () => {
		// Unresolved everywhere but the row: the "row" chip and the shadowed
		// list are `VariablePopover`'s own reading of `origins`, not something
		// `resolved`/`value` need to say twice - see `variable-popover.test.tsx`'s
		// "a bound data row outranks every definition" for the same shape.
		const { container } = renderToken({
			name: "email",
			value: "",
			resolved: false,
			sourceName: undefined,
			variables: withRow,
		});
		hover(container);
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("row")).toBeInTheDocument();
		expect(within(dialog).getByText("staging@acme.io")).toBeInTheDocument();
	});
});

describe("no accidental writes or focus theft from a hover", () => {
	it("closes without writing anything when the pointer just moves away", () => {
		const onValueChange = vi.fn();
		const { container } = renderToken({ onValueChange });
		hover(container);
		expect(screen.getByRole("dialog")).toBeInTheDocument();

		leave(container);
		act(() => vi.advanceTimersByTime(TIMING.TOOLTIP_DELAY_MS));

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		// Mutation check: this is `VariablePopover`'s existing
		// `editValue !== openValueRef.current` guard - break it and this fails.
		expect(onValueChange).not.toHaveBeenCalled();
	});

	it("never moves focus merely by opening from a hover", () => {
		const { container } = renderToken();
		const before = document.activeElement;
		hover(container);
		expect(document.activeElement).toBe(before);
	});

	it("stays open across the grace period once the pointer moves into the popover itself", () => {
		const { container } = renderToken();
		hover(container);
		leave(container);
		// `mouseover`, not `mouseenter`: the tracking is delegated on `document`
		// (see `EditableVariable`'s own comment on why), and only `mouseover`
		// bubbles there for it to catch.
		fireEvent.mouseOver(popoverContent());

		act(() => vi.advanceTimersByTime(TIMING.TOOLTIP_DELAY_MS * 3));

		// Mutation check: close on the token's own leave with no grace at all,
		// and this closes before the popover content is ever reached.
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});

	it("closes once the pointer has left the popover too, after its own grace", () => {
		const { container } = renderToken();
		hover(container);
		leave(container);
		const content = popoverContent();
		fireEvent.mouseOver(content);
		fireEvent.mouseOut(content, { relatedTarget: document.body });

		act(() => vi.advanceTimersByTime(TIMING.TOOLTIP_DELAY_MS));

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("does not close while the reader has actually focused into it to edit", () => {
		const { container } = renderToken();
		hover(container);
		screen.getByDisplayValue("mrc_8813").focus();
		leave(container);

		act(() => vi.advanceTimersByTime(TIMING.TOOLTIP_DELAY_MS));

		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});
});

describe("the keyboard chord", () => {
	it("opens the popover focused, since a keyboard user has no hover state", () => {
		renderToken();
		const trigger = screen.getByRole("button", { name: /merchantId/ });
		fireEvent.keyDown(trigger, { key: "Enter" });

		const dialog = screen.getByRole("dialog");
		expect(dialog.contains(document.activeElement)).toBe(true);
	});
});

describe("clicking the token", () => {
	it("does not open the popover by itself any more", () => {
		renderToken();
		const trigger = screen.getByRole("button", { name: /merchantId/ });
		fireEvent.click(trigger);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("still does not open one already open from a keyboard focus, or close it either", () => {
		// A click that lands on the token while it is already open (say, from a
		// prior hover) is only redefined for opening - `VariableInput/index.tsx`
		// places a caret instead of doing anything here.
		renderToken();
		const trigger = screen.getByRole("button", { name: /merchantId/ });
		fireEvent.keyDown(trigger, { key: "Enter" });
		expect(screen.getByRole("dialog")).toBeInTheDocument();

		fireEvent.click(trigger);
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});
});
