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
 * Neither text layer of `VariableInput` may ligate (#3783).
 *
 * Blink paints stale glyph positions in a native <input> after incremental
 * typing when the font ligates `//`, so a typed URL reads "http: /host". The
 * overlay has to be set the same way as the input or the two layers disagree on
 * glyph widths. jsdom resolves no stylesheet, so this asserts the class each
 * layer declares.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { variableSupportStub } from "@/test/variable-support";
import VariableInput from "./index";

const NO_LIGATURES = "[font-variant-ligatures:none]";

const scope = variableSupportStub({
	base_url: { value: "https://api.example.com", scope: "global" },
});

function renderWith(value: string, variables?: typeof scope) {
	const { container } = render(
		<TooltipProvider>
			<VariableInput
				value={value}
				onChange={() => {}}
				placeholder="URL"
				variables={variables}
			/>
		</TooltipProvider>
	);
	return container;
}

describe("VariableInput ligatures", () => {
	it("turns ligatures off on the input, with and without a variable", () => {
		for (const container of [renderWith("http://host"), renderWith("{{base_url}}/x", scope)]) {
			const input = container.querySelector("input")!;
			expect(input.className).toContain(NO_LIGATURES);
		}
	});

	it("turns ligatures off on the overlay, so it shapes like the input", () => {
		const overlay = renderWith("{{base_url}}/users", scope).querySelector(
			"[data-variable-overlay]"
		)!;
		expect(overlay).toBeTruthy();
		expect(overlay.className).toContain(NO_LIGATURES);
	});
});
