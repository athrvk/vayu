/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { Input } from "@/components/ui";

interface SecondsInputProps {
	id: string;
	/** Absent when the field is empty: the config then carries no member at all. */
	value: number | undefined;
	onChange: (seconds: number | undefined) => void;
	placeholder?: string;
	min?: number;
	max?: number;
}

/**
 * A whole number of seconds for an optional config member. Emptying the field
 * reports `undefined` so the member is removed rather than stored as `0`, which
 * the engine reads as a different thing from absent.
 */
export default function SecondsInput({
	id,
	value,
	onChange,
	placeholder,
	min,
	max,
}: SecondsInputProps) {
	return (
		<Input
			id={id}
			type="number"
			inputMode="numeric"
			step={1}
			min={min}
			max={max}
			value={value ?? ""}
			placeholder={placeholder}
			onChange={(e) => {
				const text = e.target.value;
				if (text === "") return onChange(undefined);
				const seconds = Number(text);
				if (Number.isFinite(seconds)) onChange(Math.trunc(seconds));
			}}
			// Fixed rem, not `w-28`: a number of seconds is a text measure that
			// should not narrow at the Default density the way `--spacing` does.
			className="w-[7rem]"
		/>
	);
}
