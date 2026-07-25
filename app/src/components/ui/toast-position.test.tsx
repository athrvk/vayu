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
 * The toast stack must not sit on top of the Dock.
 *
 * It did. The viewport is `position: fixed`, so it anchors to the window rather
 * than to the layout, and `bottom-4` put it 16px off the window floor - inside
 * the Dock's 32px band, covering its lower half including "Connected" and the
 * version string. Measured in the running app: viewport bottom 704px, Dock top
 * 688px. After the fix, 672 against 688.
 *
 * jsdom does no layout, so none of this can measure the overlap - `getBoundingClientRect`
 * returns zeroes here. What it can guard is the thing that made the bug possible:
 * the offset and the Dock's height were two unrelated literals in two files, with
 * nothing pointing either at the other. Both now go through `--dock-height`, and
 * these tests fail if either side stops referencing it.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ToastProvider, ToastViewport } from "./toast";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..");

// Read from disk, never `import`: vitest stubs CSS imports to "", and a scan of
// an empty string passes every assertion made against it.
const css = readFileSync(join(src, "index.css"), "utf8");
const dock = readFileSync(join(src, "components", "layout", "Dock.tsx"), "utf8");

describe("toast stack position", () => {
	afterEach(cleanup);

	it("reads the files it scans", () => {
		// A scan that silently read nothing passed for weeks elsewhere in this repo.
		expect(css.length).toBeGreaterThan(1000);
		expect(dock.length).toBeGreaterThan(1000);
	});

	it("declares --dock-height once, theme-independently", () => {
		const declarations = [...css.matchAll(/--dock-height:\s*([^;]+);/g)].map((m) =>
			m[1].trim()
		);
		expect(declarations).toEqual(["2rem"]);
	});

	it("offsets the viewport by the Dock's height, not a literal", () => {
		// Rendered, not source-scanned: the class list is assembled by `cn()`, and
		// a scan cannot see what tailwind-merge does to it.
		render(
			<ToastProvider>
				<ToastViewport data-testid="vp" />
			</ToastProvider>
		);
		const vp = screen.getByTestId("vp");
		expect(vp.className).toContain("var(--dock-height)");
		// The literal this replaced. `bottom-4` is what put the stack on the Dock.
		expect(vp.className).not.toMatch(/\bbottom-4\b/);
	});

	it("keeps the Dock's own height on the same token", () => {
		// If the Dock goes back to a bare `h-8`, the two can drift again: the
		// viewport would keep offsetting by 2rem while the strip changed height.
		expect(dock).toContain("h-[var(--dock-height)]");
		expect(dock).not.toMatch(/className="[^"]*\bh-8\b[^"]*border-t/);
	});
});
