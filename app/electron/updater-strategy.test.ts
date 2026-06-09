/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test } from "vitest";
import { resolveUpdateStrategy } from "./updater-strategy.js";

describe("resolveUpdateStrategy", () => {
	test("disables updates in development regardless of platform", () => {
		expect(resolveUpdateStrategy({ platform: "win32", isDev: true, isAppImage: false })).toBe(
			"disabled"
		);
		expect(resolveUpdateStrategy({ platform: "darwin", isDev: true, isAppImage: false })).toBe(
			"disabled"
		);
	});

	test("macOS is notify-only because the app is ad-hoc signed", () => {
		expect(resolveUpdateStrategy({ platform: "darwin", isDev: false, isAppImage: false })).toBe(
			"notify"
		);
	});

	test("Windows updates silently", () => {
		expect(resolveUpdateStrategy({ platform: "win32", isDev: false, isAppImage: false })).toBe(
			"silent"
		);
	});

	test("Linux AppImage updates silently", () => {
		expect(resolveUpdateStrategy({ platform: "linux", isDev: false, isAppImage: true })).toBe(
			"silent"
		);
	});

	test("Linux non-AppImage (deb) is notify-only", () => {
		expect(resolveUpdateStrategy({ platform: "linux", isDev: false, isAppImage: false })).toBe(
			"notify"
		);
	});

	test("unknown platforms fall back to notify", () => {
		expect(
			resolveUpdateStrategy({ platform: "freebsd", isDev: false, isAppImage: false })
		).toBe("notify");
	});
});
