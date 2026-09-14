/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi } from "vitest";
import { accentHexToColorScheme, installAccentBridge, ACCENT_COLOR_CHANNEL } from "./accent-color";

describe("accentHexToColorScheme", () => {
	it("returns null for invalid input", () => {
		expect(accentHexToColorScheme(null)).toBeNull();
		expect(accentHexToColorScheme(undefined)).toBeNull();
		expect(accentHexToColorScheme("")).toBeNull();
		expect(accentHexToColorScheme("invalid")).toBeNull();
	});

	it("maps reference hues to their corresponding schemes", () => {
		// Sunset: hue 24 - orange
		expect(accentHexToColorScheme("#ff6b35ff")).toBe("sunset");

		// Sky: hue 192 - cyan
		expect(accentHexToColorScheme("#00c4e6ff")).toBe("sky");

		// Ocean: hue 217 - blue
		expect(accentHexToColorScheme("#4a90dbff")).toBe("ocean");

		// Forest: hue 142 - green
		expect(accentHexToColorScheme("#66bb6aff")).toBe("forest");

		// Coral: hue 0/360 - red
		expect(accentHexToColorScheme("#ff0000ff")).toBe("coral");
	});

	it("maps low saturation accents to graphite", () => {
		// Low saturation gray (Windows Graphite-like)
		expect(accentHexToColorScheme("#808080ff")).toBe("graphite");
		// Also test a desaturated color
		expect(accentHexToColorScheme("#8b8b7dff")).toBe("graphite");
	});

	it("maps hues between schemes to the nearest one", () => {
		// Hue 200 is between Sky (192) and Ocean (217), closer to Sky
		expect(accentHexToColorScheme("#3eb5d9ff")).toBe("sky");

		// Hue around 215 is very close to Ocean (217)
		expect(accentHexToColorScheme("#4a90dbff")).toBe("ocean");
	});

	it("handles hue wrap-around at 360/0 (red)", () => {
		// Coral is at hue 0, test values near 360 and near 0
		expect(accentHexToColorScheme("#ff3333ff")).toBe("coral");
		expect(accentHexToColorScheme("#ff0000ff")).toBe("coral");
	});

	it("handles hex colors with or without alpha channel", () => {
		// With alpha (#rrggbbaa)
		expect(accentHexToColorScheme("#4a90dbff")).toBe("ocean");
		// Without alpha (#rrggbb)
		expect(accentHexToColorScheme("#4a90db")).toBe("ocean");
	});

	it("is case insensitive", () => {
		expect(accentHexToColorScheme("#4A90DBFF")).toBe("ocean");
		expect(accentHexToColorScheme("#4a90dbff")).toBe("ocean");
	});
});

describe("installAccentBridge", () => {
	it("does nothing on Linux", () => {
		const getAccentColor = () => "#4a90dbff";
		const onAccentChanged = vi.fn((_cb: () => void) => () => {});
		const send = vi.fn();
		const windowGet = () => ({ webContents: { send } });
		const log = vi.fn();

		const cleanup = installAccentBridge({
			platform: "linux",
			getAccentColor,
			onAccentChanged,
			window: windowGet,
			log,
		});

		// No listener installed
		expect(onAccentChanged).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();

		// Cleanup is a no-op
		cleanup();
		expect(log).not.toHaveBeenCalled();
	});

	it("installs listener on Windows", () => {
		let capturedCb: (() => void) | undefined;
		const getAccentColor = () => "#4a90dbff";
		const onAccentChanged = vi.fn((cb: () => void) => {
			capturedCb = cb;
			return () => {};
		});
		const send = vi.fn();
		const windowGet = () => ({ webContents: { send } });
		const log = vi.fn();

		installAccentBridge({
			platform: "win32",
			getAccentColor,
			onAccentChanged,
			window: windowGet,
			log,
		});

		// Listener was installed
		expect(onAccentChanged).toHaveBeenCalledTimes(1);

		// Simulate accent change
		if (capturedCb) {
			capturedCb();
		}

		// Message was sent to window
		expect(send).toHaveBeenCalledWith(ACCENT_COLOR_CHANNEL, {
			accentScheme: "ocean",
		});
	});

	it("installs listener on macOS", () => {
		let capturedCb: (() => void) | undefined;
		const getAccentColor = () => "#4a90dbff";
		const onAccentChanged = vi.fn((cb: () => void) => {
			capturedCb = cb;
			return () => {};
		});
		const send = vi.fn();
		const windowGet = () => ({ webContents: { send } });
		const log = vi.fn();

		installAccentBridge({
			platform: "darwin",
			getAccentColor,
			onAccentChanged,
			window: windowGet,
			log,
		});

		// Listener was installed
		expect(onAccentChanged).toHaveBeenCalledTimes(1);

		// Simulate accent change
		if (capturedCb) {
			capturedCb();
		}

		// Message was sent
		expect(send).toHaveBeenCalledWith(ACCENT_COLOR_CHANNEL, {
			accentScheme: "ocean",
		});
	});

	it("does not send when window is destroyed", () => {
		let capturedCb: (() => void) | undefined;
		const getAccentColor = () => "#4a90dbff";
		const onAccentChanged = vi.fn((cb: () => void) => {
			capturedCb = cb;
			return () => {};
		});
		const send = vi.fn();
		const windowGet = () => null;
		const log = vi.fn();

		installAccentBridge({
			platform: "win32",
			getAccentColor,
			onAccentChanged,
			window: windowGet,
			log,
		});

		// Simulate accent change
		if (capturedCb) {
			capturedCb();
		}

		// Nothing sent because window is null
		expect(send).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalled();
	});

	it("logs errors when send fails", () => {
		let capturedCb: (() => void) | undefined;
		const getAccentColor = () => "#4a90dbff";
		const onAccentChanged = vi.fn((cb: () => void) => {
			capturedCb = cb;
			return () => {};
		});
		const error = new Error("Send failed");
		const send = vi.fn(() => {
			throw error;
		});
		const windowGet = () => ({ webContents: { send } });
		const log = vi.fn();

		installAccentBridge({
			platform: "win32",
			getAccentColor,
			onAccentChanged,
			window: windowGet,
			log,
		});

		// Simulate accent change
		if (capturedCb) {
			capturedCb();
		}

		// Error was logged
		expect(log).toHaveBeenCalledWith("Failed to send accent change", {
			error: "Send failed",
		});
	});
});
