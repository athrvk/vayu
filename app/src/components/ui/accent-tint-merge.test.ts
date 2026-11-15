/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `bg-primary-tint` is a colour to tailwind-merge, so a caller's `bg-*` replaces
 * it and its `hover:` twin replaces the hover (#3515).
 *
 * An unknown `bg-<name>` is read as a colour, which is what the tint tokens are;
 * this holds that reading so a future tailwind-merge that files it elsewhere
 * (as it once did `text-hero`, see `lib/utils.ts`) fails here and not as two
 * backgrounds fighting on a chip.
 */

import { describe, it, expect } from "vitest";
import { cn } from "@/lib/utils";

describe("cn() and the accent tint tokens", () => {
	it("lets a caller background replace the tint", () => {
		expect(cn("bg-primary-tint", "bg-status-success-fill")).toBe("bg-status-success-fill");
		expect(cn("bg-status-success-fill", "bg-primary-tint")).toBe("bg-primary-tint");
	});

	it("lets a caller hover background replace the tint's hover", () => {
		expect(cn("hover:bg-primary-tint-hover", "hover:bg-accent")).toBe("hover:bg-accent");
	});

	it("keeps the rest state and the hover state side by side", () => {
		expect(cn("bg-primary-tint hover:bg-primary-tint-hover")).toBe(
			"bg-primary-tint hover:bg-primary-tint-hover"
		);
	});

	it("does not mistake the tint for a background size, position or image", () => {
		expect(cn("bg-cover bg-primary-tint")).toBe("bg-cover bg-primary-tint");
	});
});
