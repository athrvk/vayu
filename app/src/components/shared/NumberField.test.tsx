/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NumberField } from "./NumberField";

function NumericOwner({ onNumber }: { onNumber: (n: number) => void }) {
	const [n, setN] = useState(10);
	return (
		<NumberField
			id="f"
			label="Rate"
			value={n}
			onChange={(raw) => {
				const next = Number(raw);
				setN(next);
				onNumber(next);
			}}
		/>
	);
}

function StringOwner({ onRaw }: { onRaw: (raw: string) => void }) {
	const [s, setS] = useState("5");
	return (
		<NumberField
			id="f"
			label="Budget"
			value={s}
			onChange={(raw) => {
				setS(raw);
				onRaw(raw);
			}}
		/>
	);
}

describe("NumberField", () => {
	it("clearing a numeric field and typing 50 yields 50, never 0 or 050", () => {
		const onNumber = vi.fn();
		render(<NumericOwner onNumber={onNumber} />);
		const input = screen.getByLabelText("Rate") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "" } });
		expect(input.value).toBe("");
		fireEvent.change(input, { target: { value: "5" } });
		fireEvent.change(input, { target: { value: "50" } });
		expect(input.value).toBe("50");
		expect(onNumber.mock.calls.map((c) => c[0])).toEqual([5, 50]);
	});

	it("an emptied numeric field returns to the last value on blur", () => {
		render(<NumericOwner onNumber={vi.fn()} />);
		const input = screen.getByLabelText("Rate") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "" } });
		fireEvent.blur(input);
		expect(input.value).toBe("10");
	});

	it("a string field still reports an empty value", () => {
		const onRaw = vi.fn();
		render(<StringOwner onRaw={onRaw} />);
		fireEvent.change(screen.getByLabelText("Budget"), { target: { value: "" } });
		expect(onRaw).toHaveBeenLastCalledWith("");
	});
});
