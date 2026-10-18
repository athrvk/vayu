/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, it, expect } from "vitest";

import { readUplotTheme } from "./uplotTheme";

describe("readUplotTheme", () => {
	afterEach(() => {
		document.documentElement.removeAttribute("style");
	});

	function themeWith(vars: Record<string, string>) {
		const el = document.createElement("div");
		for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, value);
		document.body.appendChild(el);
		try {
			return readUplotTheme(el);
		} finally {
			el.remove();
		}
	}

	it("sets axis tick text in muted-foreground, never the below-AA subtle tier (#2302)", () => {
		const theme = themeWith({
			"--muted-foreground": "240 4% 42%",
			"--subtle-foreground": "240 4% 58%",
		});
		expect(theme.text).toBe("hsl(240 4% 42%)");
	});

	it("falls back to transparent when the token is unset", () => {
		expect(themeWith({}).text).toBe("transparent");
	});
});
