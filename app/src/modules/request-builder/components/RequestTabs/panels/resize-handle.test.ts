/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The body editor's splitter has to stay keyboard-operable.
 *
 * It shipped as a `role="separator"` with an `onMouseDown` and nothing else -
 * not focusable, no key handling - so the editor height was mouse-only. The
 * resize logic itself is covered by `useResizable.test.ts`; this guards the
 * wiring, which has no unit test because rendering BodyPanel drags in Monaco.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "BodyPanel.tsx"), "utf8");

const handle = source.slice(
	source.indexOf("function ResizeHandle"),
	source.indexOf("export default function BodyPanel")
);

describe("body editor splitter", () => {
	it("reads the component it is guarding", () => {
		expect(handle.length).toBeGreaterThan(200);
		expect(handle).toContain('role="separator"');
	});

	it("is focusable", () => {
		expect(handle).toContain("tabIndex={0}");
	});

	it("handles the window-splitter keys", () => {
		for (const key of ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]) {
			expect(handle, `no handling for ${key}`).toContain(`"${key}"`);
		}
	});

	it("reports its position, since a 6px bar shows none", () => {
		for (const attr of ["aria-valuenow", "aria-valuemin", "aria-valuemax", "aria-label"]) {
			expect(handle).toContain(attr);
		}
	});

	it("shows a focus state - the bar is 6px and otherwise invisible to find", () => {
		expect(handle).toContain("focus-visible:");
	});
});
