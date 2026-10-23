/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi } from "vitest";
import { createExternalUrlOpener, isBrowsableUrl, urlProtocol } from "./external-url.js";

describe("isBrowsableUrl", () => {
	it("accepts the two schemes a browser answers for", () => {
		expect(isBrowsableUrl("https://example.com")).toBe(true);
		expect(isBrowsableUrl("http://localhost:9876/health")).toBe(true);
	});

	it("refuses everything else, including what the OS would happily launch", () => {
		expect(isBrowsableUrl("file:///etc/passwd")).toBe(false);
		expect(isBrowsableUrl("vayu://open")).toBe(false);
		expect(isBrowsableUrl("javascript:alert(1)")).toBe(false);
		expect(isBrowsableUrl("mailto:someone@example.com")).toBe(false);
	});

	it("refuses text that is not a URL at all", () => {
		expect(isBrowsableUrl("not a url")).toBe(false);
		expect(isBrowsableUrl("")).toBe(false);
	});
});

describe("urlProtocol", () => {
	it("names the scheme, so a caller can say which one it refused", () => {
		expect(urlProtocol("vayu://open")).toBe("vayu:");
		expect(urlProtocol("https://example.com")).toBe("https:");
	});

	it("answers null for text that does not parse, which is not a scheme", () => {
		expect(urlProtocol("not a url")).toBeNull();
	});
});

describe("createExternalUrlOpener", () => {
	function setup(overrides: { focused?: boolean } = {}) {
		const state = { focused: overrides.focused ?? true, now: 10_000 };
		const openExternal = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
		const open = createExternalUrlOpener({
			isFocused: () => state.focused,
			now: () => state.now,
			openExternal,
		});
		return { state, openExternal, open };
	}

	it("opens an http(s) URL from a focused window", async () => {
		const { open, openExternal } = setup();
		await open("https://example.com/authorize");
		expect(openExternal).toHaveBeenCalledWith("https://example.com/authorize");
	});

	it("refuses while the window is not focused, without reaching the OS", async () => {
		const { open, openExternal } = setup({ focused: false });
		await expect(open("https://example.com")).rejects.toThrow(/not focused/);
		expect(openExternal).not.toHaveBeenCalled();
	});

	it("refuses a second open at 500 ms and allows it at 1000 ms", async () => {
		const { open, openExternal, state } = setup();
		await open("https://example.com/a");

		state.now += 500;
		await expect(open("https://example.com/b")).rejects.toThrow(/within a second/);
		expect(openExternal).toHaveBeenCalledTimes(1);

		state.now += 500;
		await open("https://example.com/c");
		expect(openExternal).toHaveBeenCalledTimes(2);
		expect(openExternal).toHaveBeenLastCalledWith("https://example.com/c");
	});

	it("does not count a refused call toward the interval", async () => {
		const { open, openExternal, state } = setup();
		await open("https://example.com/a");
		state.now += 900;
		await expect(open("https://example.com/b")).rejects.toThrow();
		state.now += 100;
		await open("https://example.com/c");
		expect(openExternal).toHaveBeenCalledTimes(2);
	});

	it("refuses two opens started in the same tick", async () => {
		const { open, openExternal } = setup();
		const results = await Promise.allSettled([
			open("https://example.com/a"),
			open("https://example.com/b"),
		]);
		expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
		expect(openExternal).toHaveBeenCalledTimes(1);
	});

	it("gives the slot back when the OS fails to open", async () => {
		const { open, openExternal } = setup();
		openExternal.mockRejectedValueOnce(new Error("no handler"));
		await expect(open("https://example.com/a")).rejects.toThrow("no handler");
		await open("https://example.com/b");
		expect(openExternal).toHaveBeenCalledTimes(2);
	});

	it.each(["file:///etc/passwd", "javascript:alert(1)", "smb://host/share"])(
		"refuses %s without reaching the OS",
		async (url) => {
			const { open, openExternal } = setup();
			await expect(open(url)).rejects.toThrow(/non-HTTP\(S\)/);
			expect(openExternal).not.toHaveBeenCalled();
		}
	);

	it("refuses text that is not a URL, and a non-string", async () => {
		const { open, openExternal } = setup();
		await expect(open("not a url")).rejects.toThrow("Invalid authorize URL");
		await expect(open(42)).rejects.toThrow("Invalid authorize URL");
		expect(openExternal).not.toHaveBeenCalled();
	});
});
