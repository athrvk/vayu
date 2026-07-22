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
 * A `{{variable}}` token has to use the same font as everything around it.
 *
 * `VariableInput` paints a visible overlay on top of a transparent <input>: the
 * glyphs the user reads come from the overlay, the caret they steer comes from
 * the input. The two only line up while both are set in the same typeface at the
 * same size.
 *
 * `EditableVariable` hardcoded `ui-monospace, SFMono-Regular, 'SF Mono', Menlo,
 * Consolas, 'Liberation Mono', monospace` on the token, under a comment reading
 * "Use same monospace font as input for consistent character widths". The app's
 * `--font-mono` is `"JetBrains Mono", "Consolas", "Monaco", monospace` - the
 * hardcoded stack does not contain JetBrains Mono at all, so the token was set
 * in a different face from both the text beside it and the input beneath it, and
 * the caret drifted across a URL containing a variable.
 *
 * jsdom resolves no stylesheet, so this asserts what the component *declares*:
 * no inline font-family anywhere in the overlay. That is the whole defect - an
 * inline style was the only thing that could override the inherited font.
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import VariableInput from "./index";

vi.mock("../../context/RequestBuilderContext", () => ({
	useRequestBuilderContext: () => ({
		getAllVariables: () => ({
			base_url: { value: "https://api.example.com", scope: "global" },
		}),
		updateVariable: () => {},
		resolveString: (s: string) => s,
	}),
}));

/** The input rendered with a variable in it, which is what builds the overlay. */
function withVariable() {
	const { container } = render(
		<VariableInput value="{{base_url}}/users" onChange={() => {}} placeholder="URL" />
	);
	return container;
}

describe("the variable token's typeface", () => {
	it("renders an overlay to check (guards the scan itself)", () => {
		const overlay = withVariable().querySelector('[aria-hidden="true"]');
		expect(overlay).toBeTruthy();
		expect(overlay!.textContent).toContain("{{base_url}}");
		// The literal text either side of the token is in there too.
		expect(overlay!.textContent).toContain("/users");
	});

	it("pins no font on any element in the overlay", () => {
		const overlay = withVariable().querySelector('[aria-hidden="true"]') as HTMLElement;

		const pinned = Array.from(overlay.querySelectorAll<HTMLElement>("*")).filter(
			(el) => el.style.fontFamily !== ""
		);

		expect(pinned.map((el) => `${el.textContent}: ${el.style.fontFamily}`)).toEqual([]);
	});

	it("lets the token inherit, like the plain segments beside it", () => {
		const token = withVariable().querySelector("[data-variable-token]") as HTMLElement;
		expect(token).toBeTruthy();

		const styled = token.querySelector<HTMLElement>("span.font-\\[inherit\\]");
		expect(styled, "the token should declare font-[inherit]").toBeTruthy();
		expect(styled!.textContent).toBe("{{base_url}}");
	});
});
