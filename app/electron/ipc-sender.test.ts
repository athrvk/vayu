/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { isFromAppMainFrame } from "./ipc-sender";

function appWindow() {
	const mainFrame = { name: "main frame" };
	const webContents = { mainFrame };
	return { window: { webContents }, webContents, mainFrame };
}

describe("isFromAppMainFrame", () => {
	it("accepts the app window's own top-level document", () => {
		const { window, webContents, mainFrame } = appWindow();

		expect(isFromAppMainFrame({ sender: webContents, senderFrame: mainFrame }, window)).toBe(
			true
		);
	});

	it("refuses a frame inside the app window", () => {
		const { window, webContents } = appWindow();
		const iframe = { name: "iframe" };

		expect(isFromAppMainFrame({ sender: webContents, senderFrame: iframe }, window)).toBe(
			false
		);
	});

	it("refuses another window, even its main frame", () => {
		const { window } = appWindow();
		const other = appWindow();

		expect(
			isFromAppMainFrame({ sender: other.webContents, senderFrame: other.mainFrame }, window)
		).toBe(false);
	});

	it("refuses a frame that is gone, and any sender when there is no window", () => {
		const { window, webContents, mainFrame } = appWindow();

		expect(isFromAppMainFrame({ sender: webContents, senderFrame: null }, window)).toBe(false);
		expect(isFromAppMainFrame({ sender: webContents }, window)).toBe(false);
		expect(isFromAppMainFrame({ sender: webContents, senderFrame: mainFrame }, null)).toBe(
			false
		);
	});
});
