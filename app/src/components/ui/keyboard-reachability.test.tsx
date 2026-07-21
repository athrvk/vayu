/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Controls a keyboard user could not reach.
 *
 * Vayu is a desktop tool for developers, who work from the keyboard, so a
 * control that only responds to a mouse is a broken control — not a
 * nice-to-have. Three of them, found by auditing the request editor:
 *
 *   1. `{{variable}}` tokens. The popover that shows what a variable resolves to
 *      hangs off a `<span>`, because the token sits inline in a URL or a header
 *      value. Radix's `asChild` clones handlers and `aria-*` onto that span but
 *      does not make it focusable — it assumes an already-interactive child. So
 *      every variable token in the app was mouse-only.
 *   2. The secret-reveal eye, deliberately `tabIndex={-1}`, which left a
 *      keyboard user unable to check a password or client secret they had typed.
 *   3. The key/value delete button, revealed on `group-hover` only, so keyboard
 *      focus landed on something fully transparent.
 */

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VariablePopover } from "./variable-popover";
import { SecretInput } from "./secret-input";
import { TooltipProvider } from "./tooltip";
import KeyValueRow from "@/modules/request-builder/shared/KeyValueEditor/KeyValueRow";
import { RequestBuilderContext } from "@/modules/request-builder/context/RequestBuilderContext";
import type { RequestBuilderContextValue } from "@/modules/request-builder/types";

describe("variable token popover", () => {
	function renderToken(props: Partial<React.ComponentProps<typeof VariablePopover>> = {}) {
		return render(
			<VariablePopover
				name="api_key"
				varInfo={{ value: "abc123", scope: "global" }}
				resolved
				trigger={<span>{"{{api_key}}"}</span>}
				{...props}
			/>
		);
	}

	it("is in the tab order", () => {
		renderToken();
		expect(screen.getByRole("button")).toHaveAttribute("tabindex", "0");
	});

	it("opens on Enter", () => {
		renderToken();
		const token = screen.getByRole("button");
		token.focus();
		fireEvent.keyDown(token, { key: "Enter" });
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});

	it("opens on Space, without typing a space into the field it sits in", () => {
		renderToken();
		const token = screen.getByRole("button");
		const event = createKeyEvent(" ");
		token.focus();
		fireEvent(token, event);
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(event.defaultPrevented).toBe(true);
	});

	it("leaves the tab order when disabled, rather than sitting in it doing nothing", () => {
		renderToken({ disabled: true });
		const token = screen.getByRole("button");
		expect(token).toHaveAttribute("tabindex", "-1");
		fireEvent.keyDown(token, { key: "Enter" });
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});

function createKeyEvent(key: string): KeyboardEvent {
	return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
}

function renderSecret() {
	// The reveal button is a TooltipIconButton, so it needs the provider the app
	// mounts at its root.
	return render(
		<TooltipProvider>
			<SecretInput value="hunter2" onChange={() => {}} />
		</TooltipProvider>
	);
}

describe("secret reveal toggle", () => {
	it("is reachable, so a typed secret can be checked", () => {
		renderSecret();
		const toggle = screen.getByRole("button", { name: "Show value" });
		// The fix is the absence of tabIndex={-1}: a <button> is focusable by
		// default, and -1 was explicitly removing it.
		expect(toggle).not.toHaveAttribute("tabindex", "-1");
		toggle.focus();
		expect(document.activeElement).toBe(toggle);
	});

	it("actually reveals when activated from the keyboard", () => {
		const { container } = renderSecret();
		expect(container.querySelector("input")).toHaveAttribute("type", "password");

		fireEvent.click(screen.getByRole("button", { name: "Show value" }));
		expect(container.querySelector("input")).toHaveAttribute("type", "text");
	});
});

describe("key/value row delete button", () => {
	it("becomes visible on keyboard focus, not on hover alone", () => {
		render(
			<RequestBuilderContext.Provider
				value={
					{
						resolveString: (s: string) => s,
						getAllVariables: () => [],
					} as unknown as RequestBuilderContextValue
				}
			>
				<KeyValueRow
					item={{ id: "1", key: "Accept", value: "*/*", enabled: true }}
					keyPlaceholder="Key"
					valuePlaceholder="Value"
					showResolved={false}
					allowDisable
					readOnly={false}
					onUpdate={() => {}}
					onRemove={() => {}}
				/>
			</RequestBuilderContext.Provider>
		);

		const remove = screen.getByRole("button", { name: "Remove row" });
		// Without this the button is opacity-0 while focused — a keyboard user
		// tabs onto an invisible control and Enter silently deletes the row.
		expect(remove.className).toContain("focus-visible:opacity-100");
	});
});
