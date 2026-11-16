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
 * A variable row's Delete button says what it does on keyboard focus (#3498).
 * It carried only an `aria-label`, which a sighted keyboard user never sees; the
 * app's Tooltip opens on focus. The name stays variable-specific and the
 * tooltip is the verb phrase alone.
 */

import { describe, it } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { expectTooltipOnFocus } from "@/test/tooltip-focus.testkit";
import VariableRow from "./VariableRow";
import type { VariableRowData } from "./VariableTableEditor";

function renderRow(key: string) {
	const variable: VariableRowData = {
		id: "vrow-1",
		key,
		value: "https://api.example.test",
		enabled: true,
		type: "string",
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

describe("VariableRow delete button", () => {
	it.each([["API_URL"], [""]])("opens its tooltip on focus (key %j)", async (key) => {
		renderRow(key);
		const button = screen.getByRole("button", {
			name: key ? `Delete ${key}` : "Delete variable",
		});

		await expectTooltipOnFocus(button, "Delete variable");
	});
});
