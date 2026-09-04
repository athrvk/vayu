/**
 * @vitest-environment jsdom
 */

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ContextMenuCommand, ContextMenuTarget } from "@/types/electron";
import {
	CONTEXT_ATTRIBUTE,
	VARIABLE_ATTRIBUTE,
	contextProps,
	variableProps,
	installContextMenuBridge,
	openVariablePopover,
	resolveContext,
} from "./context-menu";

/** A marked field holding a token, the shape the URL bar renders. */
function urlBarWithToken(): { field: HTMLElement; token: HTMLElement; plainText: HTMLElement } {
	document.body.innerHTML = `
		<div ${CONTEXT_ATTRIBUTE}="url-bar">
			<input />
			<div>
				<span role="button"><span ${VARIABLE_ATTRIBUTE}="baseUrl">{{baseUrl}}</span></span>
				<span id="plain">/users</span>
			</div>
		</div>
		<div ${CONTEXT_ATTRIBUTE}="monaco"><span id="body">{}</span></div>
	`;
	return {
		field: document.querySelector(`[${CONTEXT_ATTRIBUTE}="url-bar"]`)!,
		token: document.querySelector(`[${VARIABLE_ATTRIBUTE}]`)!,
		plainText: document.getElementById("plain")!,
	};
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("contextProps / variableProps", () => {
	it("spell the attribute once, from the constant", () => {
		expect(contextProps("monaco")).toEqual({ [CONTEXT_ATTRIBUTE]: "monaco" });
		expect(variableProps("baseUrl")).toEqual({ [VARIABLE_ATTRIBUTE]: "baseUrl" });
	});
});

describe("resolveContext", () => {
	it("reads the marker off the nearest marked ancestor", () => {
		const { plainText } = urlBarWithToken();

		expect(resolveContext(plainText).target).toEqual({ kind: "url-bar", variable: null });
	});

	it("names the token under the pointer", () => {
		const { token } = urlBarWithToken();

		const resolved = resolveContext(token);

		expect(resolved.target).toEqual({ kind: "url-bar", variable: "baseUrl" });
		expect(resolved.token).toBe(token);
	});

	it("reports a Monaco editor, whose own menu is the answer there", () => {
		urlBarWithToken();

		expect(resolveContext(document.getElementById("body")).target).toEqual({
			kind: "monaco",
			variable: null,
		});
	});

	it("reports a surface that draws its own menu", () => {
		document.body.innerHTML = `<div ${CONTEXT_ATTRIBUTE}="own-menu"><span id="row-label">Orders</span></div>`;

		expect(resolveContext(document.getElementById("row-label")).target).toEqual({
			kind: "own-menu",
			variable: null,
		});
	});

	it("says nothing about an unmarked surface", () => {
		urlBarWithToken();

		expect(resolveContext(document.body).target).toEqual({ kind: null, variable: null });
		expect(resolveContext(null).target).toEqual({ kind: null, variable: null });
	});
});

describe("openVariablePopover", () => {
	it("clicks the token, which is how the popover opens", () => {
		const { token } = urlBarWithToken();
		const clicked = vi.fn();
		token.addEventListener("click", clicked);

		expect(openVariablePopover(token, "baseUrl")).toBe(true);
		expect(clicked).toHaveBeenCalledTimes(1);
	});

	it("refuses a token that is gone, or one that is now a different variable", () => {
		const { token } = urlBarWithToken();
		const clicked = vi.fn();
		token.addEventListener("click", clicked);

		expect(openVariablePopover(token, "someOtherName")).toBe(false);
		token.remove();
		expect(openVariablePopover(token, "baseUrl")).toBe(false);
		expect(openVariablePopover(null, "baseUrl")).toBe(false);
		expect(clicked).not.toHaveBeenCalled();
	});
});

describe("installContextMenuBridge", () => {
	let announced: ContextMenuTarget[];
	let commands: Array<(command: ContextMenuCommand) => void>;
	let host: {
		setContextTarget: (target: ContextMenuTarget) => void;
		onContextMenuCommand: (callback: (command: ContextMenuCommand) => void) => () => void;
	};
	/** Every bridge this file installs, so one test's listener cannot answer the next. */
	let installed: Array<() => void>;

	/** Install and remember the teardown. */
	function install(bridgeHost: typeof host | undefined = host) {
		const teardown = installContextMenuBridge(bridgeHost, window);
		installed.push(teardown);
		return teardown;
	}

	beforeEach(() => {
		announced = [];
		commands = [];
		installed = [];
		host = {
			setContextTarget: (target) => announced.push(target),
			onContextMenuCommand: (callback) => {
				commands.push(callback);
				return () => {
					commands = commands.filter((entry) => entry !== callback);
				};
			},
		};
	});

	afterEach(() => {
		for (const teardown of installed) teardown();
	});

	function rightClick(element: Element) {
		element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
	}

	it("announces what the click landed on", () => {
		const { token, plainText } = urlBarWithToken();
		install();

		rightClick(token);
		rightClick(plainText);

		expect(announced).toEqual([
			{ kind: "url-bar", variable: "baseUrl" },
			{ kind: "url-bar", variable: null },
		]);
	});

	it("hears the click even where a handler stops it propagating, as Monaco does", () => {
		urlBarWithToken();
		const editor = document.querySelector<HTMLElement>(`[${CONTEXT_ATTRIBUTE}="monaco"]`)!;
		editor.addEventListener("contextmenu", (event) => event.stopPropagation());
		install();

		rightClick(document.getElementById("body")!);

		expect(announced).toEqual([{ kind: "monaco", variable: null }]);
	});

	it("opens the popover of the token the menu was opened over", () => {
		const { token, plainText } = urlBarWithToken();
		const clicked = vi.fn();
		token.addEventListener("click", clicked);
		install();

		rightClick(token);
		commands[0]({ type: "edit-variable", name: "baseUrl" });

		expect(clicked).toHaveBeenCalledTimes(1);

		// A later right-click somewhere else replaces the token it would open.
		rightClick(plainText);
		commands[0]({ type: "edit-variable", name: "baseUrl" });

		expect(clicked).toHaveBeenCalledTimes(1);
	});

	it("leaves the command the URL bar owns alone", () => {
		const { token } = urlBarWithToken();
		const clicked = vi.fn();
		token.addEventListener("click", clicked);
		install();

		rightClick(token);
		commands[0]({ type: "import-command", text: "curl https://example.com" });

		expect(clicked).not.toHaveBeenCalled();
	});

	it("stops announcing once torn down", () => {
		const { token } = urlBarWithToken();

		install()();
		rightClick(token);

		expect(announced).toEqual([]);
		expect(commands).toEqual([]);
	});

	it("does nothing at all outside Electron", () => {
		const { token } = urlBarWithToken();

		install(undefined)();
		rightClick(token);

		expect(announced).toEqual([]);
	});
});
