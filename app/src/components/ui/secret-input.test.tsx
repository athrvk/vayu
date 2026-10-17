/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @vitest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SecretInput } from "./secret-input";
import { TooltipProvider } from "./tooltip";

describe("SecretInput id", () => {
	it("reaches the input, so a label's htmlFor names the field", () => {
		render(
			<TooltipProvider>
				<label htmlFor="secret-under-test">Client secret</label>
				<SecretInput id="secret-under-test" value="hunter2" onChange={() => {}} />
			</TooltipProvider>
		);

		const field = screen.getByLabelText("Client secret");
		expect(field.tagName).toBe("INPUT");
		expect(field).toHaveAttribute("id", "secret-under-test");
	});
});
