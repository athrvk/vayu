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
 * The toast stack must not sit on top of the app's chrome, at either edge.
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
import { TOAST_POSITIONS } from "@/constants/toast";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..");

// Read from disk, never `import`: vitest stubs CSS imports to "", and a scan of
// an empty string passes every assertion made against it.
const css = readFileSync(join(src, "index.css"), "utf8");
const dock = readFileSync(join(src, "components", "layout", "Dock.tsx"), "utf8");
const titleBar = readFileSync(join(src, "components", "layout", "TitleBar.tsx"), "utf8");
const electronConstants = readFileSync(join(src, "..", "electron", "constants.ts"), "utf8");

describe("toast stack position", () => {
	afterEach(cleanup);

	it("reads the files it scans", () => {
		// A scan that silently read nothing passed for weeks elsewhere in this repo.
		expect(css.length).toBeGreaterThan(1000);
		expect(dock.length).toBeGreaterThan(1000);
		expect(titleBar.length).toBeGreaterThan(1000);
		expect(electronConstants.length).toBeGreaterThan(500);
	});

	it("declares --dock-height once, theme-independently", () => {
		const declarations = [...css.matchAll(/--dock-height:\s*([^;]+);/g)].map((m) =>
			m[1].trim()
		);
		expect(declarations).toEqual(["2rem"]);
	});

	it("declares --titlebar-height for the toasts to subtract", () => {
		// Only that the token exists and is a length. Its *value* is per platform
		// (macOS 28px, Windows and Linux 32px) and is held against
		// electron/constants.ts by titlebar-height.test.ts - asserting a single
		// number here is what this test used to do, and it broke the moment the
		// height became platform-dependent while saying nothing about toasts.
		const declarations = [...css.matchAll(/--titlebar-height:\s*([^;]+);/g)].map((m) =>
			m[1].trim()
		);
		expect(declarations.length).toBeGreaterThan(0);
		for (const value of declarations) expect(value).toMatch(/^\d+px$/);
		expect(electronConstants).toContain("TITLEBAR_HEIGHT");
	});

	it("clears the chrome on its own edge for every offered position", () => {
		// The whole point of making position configurable is that there is no
		// longer a single corner to check. A new entry reaching for `bottom-4`
		// reintroduces exactly the bug this file was opened for.
		expect(TOAST_POSITIONS.length).toBeGreaterThan(1);
		for (const p of TOAST_POSITIONS) {
			const edge = p.value.startsWith("bottom") ? "--dock-height" : "--titlebar-height";
			expect(p.className, `${p.value} must offset by ${edge}`).toContain(`var(${edge})`);
			expect(p.className, `${p.value} uses a bare offset`).not.toMatch(/\b(bottom|top)-\d/);
		}
	});

	it("offers the positions in the order they appear on screen", () => {
		// The picker renders this array straight into a 3-column grid, so the
		// order IS the layout: sorted any other way, "Bottom right" turns up in
		// the top-left cell.
		expect(TOAST_POSITIONS.map((p) => p.value)).toEqual([
			"top-left",
			"top-center",
			"top-right",
			"bottom-left",
			"bottom-center",
			"bottom-right",
		]);
	});

	it("puts the offset on the rendered viewport", () => {
		// Rendered, not source-scanned: the class list is assembled by `cn()`, and
		// a scan cannot see what tailwind-merge does to it.
		const bottomRight = TOAST_POSITIONS.find((p) => p.value === "bottom-right")!;
		render(
			<ToastProvider>
				<ToastViewport data-testid="vp" className={bottomRight.className} />
			</ToastProvider>
		);
		const vp = screen.getByTestId("vp");
		expect(vp.className).toContain("var(--dock-height)");
		// The literal this replaced. `bottom-4` is what put the stack on the Dock.
		expect(vp.className).not.toMatch(/\bbottom-4\b/);
	});

	it("keeps the title bar's own height on the same token", () => {
		// Same drift risk as the Dock: a bare h-[38px] here and a top-anchored
		// stack would keep offsetting by a value the strip no longer has.
		expect(titleBar).toContain("h-[var(--titlebar-height)]");
	});

	it("keeps the Dock's own height on the same token", () => {
		// If the Dock goes back to a bare `h-8`, the two can drift again: the
		// viewport would keep offsetting by 2rem while the strip changed height.
		expect(dock).toContain("h-[var(--dock-height)]");
		expect(dock).not.toMatch(/className="[^"]*\bh-8\b[^"]*border-t/);
	});
});
