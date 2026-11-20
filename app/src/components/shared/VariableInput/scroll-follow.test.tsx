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
 * The token overlay follows the input's horizontal scroll (issue #3684).
 *
 * Once a value holds a `{{token}}` the input's own text is transparent and the
 * overlay paints it. The input scrolls with the caret; the overlay is
 * `overflow-hidden` and would stay at 0, hiding whatever is typed past the field's
 * width. jsdom has no layout, so the offset is set by hand on the input and the
 * overlay is read back.
 */

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { variableSupportStub } from "@/test/variable-support";
import VariableInput from "./index";

function renderInput(value: string) {
	const scope = variableSupportStub({ merchantId: { value: "m_1", scope: "global" } });
	const props = { onChange: () => {}, "aria-label": "URL", variables: scope };
	const utils = render(
		<TooltipProvider delayDuration={0}>
			<VariableInput value={value} {...props} />
		</TooltipProvider>
	);
	const input = screen.getByLabelText("URL") as HTMLInputElement;
	const overlay = () => utils.container.querySelector<HTMLElement>("[data-variable-overlay]");
	const rerender = (next: string) =>
		utils.rerender(
			<TooltipProvider delayDuration={0}>
				<VariableInput value={next} {...props} />
			</TooltipProvider>
		);
	return { input, overlay, rerender };
}

describe("VariableInput overlay scroll", () => {
	it("copies the input's scroll offset to the overlay on a scroll event", () => {
		const { input, overlay } = renderInput("{{merchantId}}/orders/with/a/long/tail");
		expect(overlay()).not.toBeNull();
		expect(overlay()?.scrollLeft).toBe(0);

		input.scrollLeft = 120;
		fireEvent.scroll(input);

		expect(overlay()?.scrollLeft).toBe(120);
	});

	it("follows the input back to the start", () => {
		const { input, overlay } = renderInput("{{merchantId}}/orders/with/a/long/tail");
		input.scrollLeft = 120;
		fireEvent.scroll(input);
		input.scrollLeft = 0;
		fireEvent.scroll(input);

		expect(overlay()?.scrollLeft).toBe(0);
	});

	it("re-syncs after a value change that raises no scroll event", () => {
		const { input, overlay, rerender } = renderInput("{{merchantId}}/a");
		input.scrollLeft = 80;
		rerender("{{merchantId}}/ab");

		expect(overlay()?.scrollLeft).toBe(80);
	});
});
