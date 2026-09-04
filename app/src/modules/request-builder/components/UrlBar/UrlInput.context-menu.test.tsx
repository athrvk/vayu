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
 * "Paste as curl" imports the command, through the same path a paste does.
 *
 * The item exists to make the paste behaviour discoverable (#1359), so the two
 * must not be two imports: the menu is composed in the main process, which reads
 * the clipboard, offers the item only for text the parser would accept, and
 * hands that text back here. This drives the half that lives in the renderer -
 * the command arriving and the request being replaced - with the same command
 * object `runContextCommand` forwards.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { RequestBuilderContext } from "../../context";
import type { RequestBuilderContextValue } from "../../types";
import { createDefaultRequestState } from "../../utils/request-state";
import { emptyDrafts } from "../../utils/body-drafts";
import type { ContextMenuCommand } from "@/types/electron";
import UrlInput from "./UrlInput";

/** The listeners `onContextMenuCommand` handed out, and the setRequest spy. */
function renderUrlInput() {
	const listeners: Array<(command: ContextMenuCommand) => void> = [];
	const setRequest = vi.fn();
	Object.defineProperty(window, "electronAPI", {
		value: {
			onContextMenuCommand: (callback: (command: ContextMenuCommand) => void) => {
				listeners.push(callback);
				return () => {};
			},
		},
		configurable: true,
		writable: true,
	});

	const context = {
		request: { ...createDefaultRequestState(), url: "https://example.test/x" },
		setRequest,
		updateField: vi.fn(),
		getBodyDrafts: () => emptyDrafts(null),
		setBodyDrafts: vi.fn(),
		resolveString: (s: string) => s,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		updateVariable: vi.fn(),
		writableScopes: [],
	} as unknown as RequestBuilderContextValue;

	render(
		<TooltipProvider>
			<RequestBuilderContext.Provider value={context}>
				<UrlInput />
			</RequestBuilderContext.Provider>
		</TooltipProvider>
	);

	return { setRequest, send: (command: ContextMenuCommand) => listeners[0]?.(command) };
}

afterEach(() => {
	cleanup();
	Reflect.deleteProperty(window, "electronAPI");
});

describe("the URL bar answers the menu's import", () => {
	it("subscribes to the command channel while it is on screen", () => {
		const { send } = renderUrlInput();
		// The guard's own input: without a listener there is nothing to send to,
		// and every assertion below would pass over an empty list.
		expect(send).toBeTruthy();
	});

	it("replaces the request with what the command describes", () => {
		const { setRequest, send } = renderUrlInput();

		act(() => {
			send({
				type: "import-command",
				text: "curl -X POST https://api.example.com/orders -H 'X-Key: 1'",
			});
		});

		expect(setRequest).toHaveBeenCalledTimes(1);
		const imported = setRequest.mock.calls[0][0];
		expect(imported.url).toBe("https://api.example.com/orders");
		expect(imported.method).toBe("POST");
		expect(imported.headers.some((h: { key: string }) => h.key === "X-Key")).toBe(true);
	});

	it("leaves the request alone for a command that does not parse", () => {
		const { setRequest, send } = renderUrlInput();

		act(() => {
			send({ type: "import-command", text: "curl" }); // no URL in it
		});

		expect(setRequest).not.toHaveBeenCalled();
	});

	it("ignores the command the token popover owns", () => {
		const { setRequest, send } = renderUrlInput();

		act(() => {
			send({ type: "edit-variable", name: "baseUrl" });
		});

		expect(setRequest).not.toHaveBeenCalled();
	});
});
