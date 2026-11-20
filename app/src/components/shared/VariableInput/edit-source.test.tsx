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
 * A token's edit reaches `updateVariable` with the resolved definition's
 * `sourceId` (#3683).
 *
 * `varInfo` used to be rebuilt in `EditableVariable` without it, and
 * `handleVariableChange` forwarded three arguments, so the writer could only
 * guess which collection held the definition. Each hop is a place the id can be
 * dropped; this drives the whole path from the field to the support object.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { variableSupportStub } from "@/test/variable-support";
import type { ResolvedVariable } from "@/types";
import VariableInput from "./index";

const inherited: ResolvedVariable = {
	value: "https://root",
	scope: "collection",
	sourceId: "col-root",
	sourceName: "Root",
};

describe("editing a token in a variable field", () => {
	it("reaches updateVariable with the sourceId of the definition it showed", () => {
		const updateVariable = vi.fn();
		render(
			<TooltipProvider>
				<VariableInput
					value="{{baseUrl}}/users"
					onChange={() => {}}
					aria-label="URL"
					variables={variableSupportStub({ baseUrl: inherited }, { updateVariable })}
				/>
			</TooltipProvider>
		);

		const token = screen.getByRole("button", { name: /baseUrl/ });
		fireEvent.keyDown(token, { key: "Enter" });
		const field = within(screen.getByRole("dialog")).getByLabelText("Value of baseUrl");
		fireEvent.change(field, { target: { value: "https://new" } });
		fireEvent.keyDown(field, { key: "Enter" });

		expect(updateVariable).toHaveBeenCalledWith(
			"baseUrl",
			"https://new",
			"collection",
			"col-root"
		);
	});
});
