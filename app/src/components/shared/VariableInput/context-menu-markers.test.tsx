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
 * The markers a right-click reads, on the components that carry them (#1359).
 *
 * `lib/context-menu.test.ts` proves the bridge reads a marked DOM correctly;
 * this proves the app renders one. That gap is exactly the defect this repo
 * repeats - a field written and never read - and here it would be silent: an
 * unmarked URL bar still opens a menu, just without the two offers that make it
 * the URL bar's.
 *
 * So the whole path is driven: render the field, right-click the token in it,
 * and check both that the main process is told what it needs and that the
 * command it sends back opens the popover a click opens.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { variableSupportStub } from "@/test/variable-support";
import type { ContextMenuCommand, ContextMenuTarget } from "@/types/electron";
import { VARIABLE_ATTRIBUTE, installContextMenuBridge } from "@/lib/context-menu";
import VariableInput from "./index";

const scope = variableSupportStub({
	baseUrl: { value: "https://api.example.com", scope: "global" },
});

function renderUrlBar() {
	return render(
		<TooltipProvider>
			<VariableInput
				value="{{baseUrl}}/users"
				onChange={() => {}}
				placeholder="URL"
				contextKind="url-bar"
				variables={scope}
			/>
		</TooltipProvider>
	);
}

/** The bridge, plus what it announced and the commands it is listening for. */
function bridge() {
	const announced: ContextMenuTarget[] = [];
	const listeners: Array<(command: ContextMenuCommand) => void> = [];
	const teardown = installContextMenuBridge(
		{
			setContextTarget: (target) => announced.push(target),
			onContextMenuCommand: (callback) => {
				listeners.push(callback);
				return () => {};
			},
		},
		window
	);
	return { announced, send: (command: ContextMenuCommand) => listeners[0]?.(command), teardown };
}

const teardowns: Array<() => void> = [];

afterEach(() => {
	while (teardowns.length) teardowns.pop()?.();
});

function rightClick(element: Element) {
	element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
}

describe("the URL bar's context markers", () => {
	it("names the field and the token the pointer is on", () => {
		const { container } = renderUrlBar();
		const { announced, teardown } = bridge();
		teardowns.push(teardown);

		const token = container.querySelector(`[${VARIABLE_ATTRIBUTE}]`);
		expect(token, "the token should carry its name for the menu").toBeTruthy();

		rightClick(token!);

		expect(announced).toEqual([{ kind: "url-bar", variable: "baseUrl" }]);
	});

	it("names the field alone for a right-click on its plain text", () => {
		const { container } = renderUrlBar();
		const { announced, teardown } = bridge();
		teardowns.push(teardown);

		rightClick(container.querySelector("input")!);

		expect(announced).toEqual([{ kind: "url-bar", variable: null }]);
	});

	it("opens the token's popover when the menu item is chosen", () => {
		const { container } = renderUrlBar();
		const { send, teardown } = bridge();
		teardowns.push(teardown);

		expect(screen.queryByRole("dialog")).toBeNull();

		rightClick(container.querySelector(`[${VARIABLE_ATTRIBUTE}]`)!);
		// The click the command performs is a real one, so the state it opens
		// settles inside `act` rather than during teardown.
		act(() => {
			send({ type: "edit-variable", name: "baseUrl" });
		});

		// The same popover a click opens: Radix renders it as a dialog holding the
		// variable's name and value.
		const popover = screen.getByRole("dialog");
		expect(popover.textContent).toContain("baseUrl");
	});
});

describe("a field with no context kind", () => {
	it("is left to Chromium's own answer", () => {
		const { container } = render(
			<TooltipProvider>
				<VariableInput value="{{baseUrl}}" onChange={() => {}} variables={scope} />
			</TooltipProvider>
		);
		const { announced, teardown } = bridge();
		teardowns.push(teardown);

		rightClick(container.querySelector(`[${VARIABLE_ATTRIBUTE}]`)!);

		// Still the token, which any field's menu can offer to edit; no field kind,
		// because "Paste as curl" belongs to the URL bar alone.
		expect(announced).toEqual([{ kind: null, variable: "baseUrl" }]);
	});
});
