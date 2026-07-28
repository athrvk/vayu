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
 * The body pane's non-text previews - image, PDF, binary.
 *
 * These are the shape CLAUDE.md calls the mistake that is "enumerable, not
 * impossible": the image carried `border border-rule` inside a wrapper that was
 * a bare `bg-muted`. `border-rule` is not a colour, it is `var(--rule)`, and
 * only a declared surface sets that - so with none declared it inherited the
 * response pane's `surface-card` value, which on `--muted` measures around 1.1.
 * The outline was there in the source and absent on screen.
 *
 * That is why the guard is on the **declaration**, not on `border-rule`.
 * Asserting the border class proves nothing; it was already correct.
 *
 * The chips above each preview were also `bg-muted` inside a `bg-muted`
 * wrapper - the same colour painted on itself, so the chip shape did not exist.
 * They read as chips now because they have a rule, not a fill.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import ResponseBody from "./ResponseBody";

const PREVIEWS = [
	["image", "image/png", "iVBORw0KGgo="],
	["pdf", "application/pdf", "JVBERi0="],
	["binary", "application/octet-stream", "AAAA"],
] as const;

function renderPreview(contentType: string, body: string) {
	return render(
		<ResponseBody body={body} bodyRaw={body} headers={{ "content-type": contentType }} />
	);
}

describe.each(PREVIEWS)("the %s preview", (_name, contentType, body) => {
	it("declares the surface its rules read from", () => {
		const { container } = renderPreview(contentType, body);
		const wrapper = container.querySelector(".surface-sunken");
		expect(wrapper, "the preview wrapper must declare a surface").not.toBeNull();
	});

	it("leaves no bare bg-muted, which would give a rule nothing to resolve to", () => {
		const { container } = renderPreview(contentType, body);
		const bare = Array.from(container.querySelectorAll<HTMLElement>("*")).filter(
			(el) => /\bbg-muted\b/.test(el.className) && !/\bsurface-sunken\b/.test(el.className)
		);
		expect(bare.map((el) => el.className)).toEqual([]);
	});

	it("gives the label chip an edge rather than a same-colour fill", () => {
		const { container } = renderPreview(contentType, body);
		const chip = container.querySelector(".inline-flex.items-center");
		expect(chip, "the preview's label chip").not.toBeNull();
		expect(chip!.className).toContain("border-rule");
		expect(chip!.className).toMatch(/\brounded-md\b/);
	});
});

describe("the image itself", () => {
	it("keeps its outline, now that the wrapper declares a surface", () => {
		const { container } = renderPreview("image/png", "iVBORw0KGgo=");
		const img = container.querySelector("img");
		expect(img).not.toBeNull();
		expect(img!.className).toContain("border-rule");

		// And that outline is inside the declared surface, which is the half
		// that was missing. Asserting the class alone would have passed before.
		expect(img!.closest(".surface-sunken")).not.toBeNull();
	});
});
