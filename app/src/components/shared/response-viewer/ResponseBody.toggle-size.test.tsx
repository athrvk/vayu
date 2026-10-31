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
 * The Pretty/Raw/Preview toggle sits on the toolbar's `h-band` row (32px,
 * every density) - `toggle-group.tsx`'s own doc comment says so ("the
 * response toolbar sits an `xs` control on a 32px `band`"). The code used to
 * pick `sm` for the pane that was not `compact`: a `sm` track is `h-control`
 * (28px) plus the track's own `p-1` padding, 34px total - two pixels taller
 * than the band it sits in, overflowing the row's own border. `xs`'s track
 * (`h-control-sm` 24px plus `p-0.5`, 27px) is the one size that actually
 * clears it.
 *
 * Rendered, not a source scan: the prop is a runtime value passed down
 * through `ToggleGroup`, not a class string this file writes out directly.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ResponseBody from "./ResponseBody";

vi.mock("@/components/ui/code-editor", () => ({
	CodeEditor: () => <div data-testid="code-editor" />,
}));

describe("the body toolbar's view-mode toggle", () => {
	it("fits the 32px band", () => {
		render(
			<ResponseBody
				body='{"a":1}'
				bodyRaw='{"a":1}'
				headers={{ "content-type": "application/json" }}
			/>
		);
		const pretty = screen.getByRole("radio", { name: /pretty/i });
		expect(pretty.className).toMatch(/\bh-control-sm\b/);
		expect(pretty.className).not.toMatch(/\bh-control\b(?!-sm)/);
	});
});
