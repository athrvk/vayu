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
 * Every control in a variables row has an accessible name that says which
 * variable it edits (#2284). A placeholder is not a name, and the checkbox,
 * the type select and the delete button had nothing at all, so a screen reader
 * read the table as a column of identical anonymous controls.
 *
 * Mutation check: drop the `aria-label` from the enable checkbox, the type
 * trigger or the value input and the matching assertion below fails.
 */

import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import VariableRow from "./VariableRow";
import type { VariableRowData } from "./VariableTableEditor";

function renderRow(overrides: Partial<VariableRowData>) {
	const variable: VariableRowData = {
		id: "vrow-1",
		key: "API_URL",
		value: "https://api.example.test",
		enabled: true,
		type: "string",
		...overrides,
	};
	return render(
		<table>
			<tbody>
				<VariableRow
					variable={variable}
					checkboxColor=""
					onUpdate={() => {}}
					onCommitNow={() => {}}
					onRemove={() => {}}
					onBlur={() => {}}
					scope={null}
				/>
			</tbody>
		</table>
	);
}

describe("VariableRow: accessible names", () => {
	it("names every control of a persisted row after its variable", () => {
		renderRow({});
		expect(screen.getByRole("checkbox", { name: "Enable API_URL" })).toBeTruthy();
		expect(screen.getByRole("textbox", { name: "Variable name" })).toBeTruthy();
		expect(screen.getByRole("textbox", { name: "Value of API_URL" })).toBeTruthy();
		expect(screen.getByRole("combobox", { name: "Type of API_URL" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Delete API_URL" })).toBeTruthy();
	});

	it("names a secret row's masked value field the same way", () => {
		renderRow({ secret: true });
		const field = screen.getByLabelText("Value of API_URL");
		expect(field.getAttribute("type")).toBe("password");
	});

	it("falls back to generic names while the row has no key", () => {
		renderRow({ key: "", value: "" });
		expect(screen.getByRole("checkbox", { name: "Enable this row" })).toBeTruthy();
		expect(screen.getByRole("textbox", { name: "Variable name" })).toBeTruthy();
		expect(screen.getByRole("textbox", { name: "Variable value" })).toBeTruthy();
		expect(screen.getByRole("combobox", { name: "Variable type" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Delete variable" })).toBeTruthy();
	});
});
