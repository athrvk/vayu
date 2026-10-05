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
 * A variable whose value is a time carries the time card (#1786), and a secret
 * never does: the card is a tooltip, and a tooltip is what a screen share
 * catches. Assertions read labels and the value as typed, never the local row,
 * so no case depends on the host zone.
 *
 * Mutation check: drop `!variable.secret &&` from `showsTime` and the unsaved
 * secret case fails (its value is shown plainly, so nothing else hides it).
 */

import { describe, it, expect } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import VariableRow from "./VariableRow";
import type { VariableRowData } from "./VariableTableEditor";

const ISO = "2026-10-05T08:10:00.672Z";

function renderRow(overrides: Partial<VariableRowData>) {
	const variable: VariableRowData = {
		id: "vrow-1",
		key: "expiresAt",
		value: ISO,
		enabled: true,
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
				/>
			</tbody>
		</table>
	);
}

const marker = () => screen.queryByRole("button", { name: /in your time zone and UTC$/ });

describe("VariableRow: a value that is a time", () => {
	it("carries the card, the field still the editable input", async () => {
		renderRow({});
		const button = marker();
		expect(button?.getAttribute("aria-label")).toBe("expiresAt in your time zone and UTC");
		fireEvent.focus(button!);
		const card = await screen.findByTestId("time-hover-card");
		expect(card.textContent).toContain("UTC");
		expect(card.textContent).not.toContain("Original");
		expect(screen.getByDisplayValue(ISO).tagName).toBe("INPUT");
	});

	it("gives a plain value no card", () => {
		renderRow({ value: "https://api.example.test" });
		expect(marker()).toBeNull();
	});

	it("never puts a saved secret's value on the card", () => {
		renderRow({ secret: true });
		expect(marker()).toBeNull();
		expect(document.body.textContent).not.toContain(ISO);
	});

	it("never puts an unsaved secret's value on the card, though the field shows it", () => {
		renderRow({ secret: true, isNew: true });
		// An unsaved secret is a plain field (`isSecretField`), so the value is
		// on screen - the card is the one place it must still not reach.
		expect(screen.getByDisplayValue(ISO)).toBeTruthy();
		expect(marker()).toBeNull();
	});
});
