/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What an icon-only button owes a keyboard user (#3498): its label, visible on
 * focus. A native `title` never shows there; the app's Tooltip does, and this
 * is the one way the suite asks. Render through `@/test/render-with-tooltips`,
 * since Radix's Tooltip throws without its provider.
 */

import { act, fireEvent, screen } from "@testing-library/react";
import { expect } from "vitest";

export async function expectTooltipOnFocus(button: HTMLElement, text: string): Promise<void> {
	expect(button).not.toHaveAttribute("title");
	await act(async () => {
		fireEvent.focus(button);
	});
	expect(await screen.findByRole("tooltip")).toHaveTextContent(text);
}
