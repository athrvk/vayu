/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";

/**
 * Wait until a closing Radix menu has finished handing focus back (#3443).
 *
 * The menu leaving the DOM is not the end of it: its `FocusScope` hands focus
 * on from a `setTimeout(0)` of its own, so a test that reads
 * `document.activeElement` straight after races that hand-back, and a bug in it
 * passes whenever the read wins. A zero timeout scheduled now runs after the
 * one the menu queued, which makes what follows a read of where focus
 * *settled* - the order does not depend on the runner's speed.
 */
export async function menuClosedAndFocusSettled(): Promise<void> {
	await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
	await new Promise((resolve) => setTimeout(resolve, 0));
}
