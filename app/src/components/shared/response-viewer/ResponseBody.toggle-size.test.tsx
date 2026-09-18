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
 * every density) whether or not the pane is `compact` - `toggle-group.tsx`'s
 * own doc comment says so ("the response toolbar sits an `xs` control on a
 * 32px `band`"). The code used to say otherwise: `size={compact ? "xs" :
 * "sm"}` gave the non-compact case (the request builder's own response pane,
 * which never passes `compact`) a `sm` track - `h-control` (28px) plus the
 * track's own `p-1` padding, 34px total - two pixels taller than the band it
 * sits in, overflowing the row's own border. `xs`'s track (`h-control-sm`
 * 24px plus `p-0.5`, 27px) is the one size that actually clears it.
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
	it.each([
		["default (not compact)", {}],
		["compact", { compact: true }],
	])("fits the 32px band at %s", (_label, extraProps) => {
		render(
			<ResponseBody
				body='{"a":1}'
				bodyRaw='{"a":1}'
				headers={{ "content-type": "application/json" }}
				{...extraProps}
			/>
		);
		const pretty = screen.getByRole("radio", { name: /pretty/i });
		expect(pretty.className).toMatch(/\bh-control-sm\b/);
		expect(pretty.className).not.toMatch(/\bh-control\b(?!-sm)/);
	});
});
