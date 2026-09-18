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
 * `Label` must render `block`, not the bare `<label>` element's own default
 * `inline` - a label followed by a sibling that is not itself `w-full` or
 * `block` (`ToggleGroup`'s track is `inline-flex` sized to its content)
 * otherwise stays on the label's own line instead of starting a new one.
 * Two real call sites hit this: the load test dialog's "Response format"
 * and the client-certificate form's "Format", both a `Label` immediately
 * followed by a `ToggleGroup` in a `space-y-*` stack.
 *
 * jsdom does no layout, so this asserts the rendered class rather than a
 * position - the class is what the browser's box generation reads.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Label } from "./label";

describe("Label", () => {
	it("renders block", () => {
		const { getByText } = render(<Label>Format</Label>);
		expect(getByText("Format").className).toMatch(/\bblock\b/);
	});
});
