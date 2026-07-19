/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { isMac, modKey, formatChord } from "./platform";

// The test environment (jsdom) is not macOS, so these assert the Windows/Linux
// branch — the same rendering the Dock, tooltips, and empty states get here.
describe("platform shortcut helpers", () => {
	it("detects non-mac in the test environment", () => {
		expect(isMac).toBe(false);
	});

	it("uses word-style modifiers off macOS", () => {
		expect(modKey).toBe("Ctrl");
		expect(formatChord({ mod: true, key: "S" })).toBe("Ctrl+S");
		expect(formatChord({ mod: true, shift: true, key: "E" })).toBe("Ctrl+Shift+E");
		expect(formatChord({ mod: true, alt: true, key: "I" })).toBe("Ctrl+Alt+I");
		expect(formatChord({ key: "↵" })).toBe("↵");
	});
});
