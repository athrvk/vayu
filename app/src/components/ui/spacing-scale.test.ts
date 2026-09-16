/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Card and DialogContent are the two primitives issue #1670 tightened
 * (`p-6` to `p-4`, and `p-6 gap-4` to `p-5 gap-3`, respectively) so that
 * `--spacing`'s new default reads as 12px/15px padding rather than the old
 * 24px. This guards the two primitives directly rather than scanning the
 * whole tree for `p-6`/`p-8`/`gap-6`/`gap-8`/`space-y-6`: a codebase-wide
 * sweep would also flag `EmptyState`/`ErrorState` (`p-8`, a shared primitive
 * pattern with no hero surface in sight) and seven other `p-6` call sites
 * this issue's fix pathway never named - well past what shrinking one CSS
 * variable and two primitives was asked to touch. The three Welcome-module
 * hero surfaces (`Launcher.tsx`, `FirstRunWelcome.tsx`, `LauncherSkeleton.tsx`)
 * keep their `gap-8` untouched for the same reason: nothing here scans them.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const card = readFileSync(join(here, "card.tsx"), "utf8");
const dialog = readFileSync(join(here, "dialog.tsx"), "utf8");

describe("spacing scale - Card", () => {
	it("reads the real primitive", () => {
		expect(card.length).toBeGreaterThan(500);
	});

	it("keeps CardHeader, CardContent and CardFooter off p-6", () => {
		// Mutation check: put p-6 back on any of the three and this reds -
		// verified by hand while writing this test.
		expect(card).not.toMatch(/p-6/);
		expect(card).toContain('"flex flex-col space-y-1.5 p-4"');
		expect(card).toContain('"p-4 pt-0"');
		expect(card).toContain('"flex items-center p-4 pt-0"');
	});
});

describe("spacing scale - DialogContent", () => {
	it("reads the real primitive", () => {
		expect(dialog.length).toBeGreaterThan(500);
	});

	it("uses the tightened p-5 gap-3 panel padding, not p-6 gap-4", () => {
		expect(dialog).not.toMatch(/flex-col gap-4 .*p-6 shadow-lg/);
		expect(dialog).toContain(
			"flex-col gap-3 overflow-y-auto rounded-lg border bg-background p-5 shadow-lg"
		);
	});
});
