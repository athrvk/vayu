/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState, type ReactNode } from "react";
import { Input, Label } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * A labelled number input with its unit inside the field, `htmlFor`/`id` tying label and input.
 * Shared (#1564): `RunCollectionDialog` reuses it for the budget fields `LoadTestConfigDialog`
 * introduced it for. A numeric `value` makes it a number field: the typed text is held here while
 * focused and `onChange` hears only non-empty text, so clearing it to retype never writes
 * `Number("")` (0); on blur an empty field returns to `value`. A string `value` passes through, as
 * the budget fields read "" as "no budget".
 */
export function NumberField({
	id,
	label,
	unit,
	value,
	onChange,
	min,
	max,
	placeholder,
	hint,
	optional,
	action,
}: {
	id: string;
	label: string;
	unit?: string;
	value: number | string;
	onChange: (raw: string) => void;
	min?: number;
	max?: number;
	placeholder?: string;
	hint?: string;
	optional?: boolean;
	/** A control beside the input, such as a row-level copy button. */
	action?: ReactNode;
}) {
	const hintId = hint ? `${id}-hint` : undefined;
	const numeric = typeof value === "number";
	const [draft, setDraft] = useState<string | null>(null);
	const handleChange = (raw: string) => {
		if (!numeric) {
			onChange(raw);
			return;
		}
		setDraft(raw);
		if (raw !== "") onChange(raw);
	};
	return (
		<div className="space-y-1.5">
			<Label htmlFor={id} className="text-xs">
				{label}
				{optional && (
					<span className="ml-1 font-normal text-muted-foreground">(optional)</span>
				)}
			</Label>
			<div className="flex items-center gap-2">
				<div className="relative min-w-0 flex-1">
					<Input
						id={id}
						type="number"
						inputMode="numeric"
						value={draft ?? value}
						onChange={(e) => handleChange(e.target.value)}
						onBlur={() => setDraft(null)}
						min={min}
						max={max}
						placeholder={placeholder}
						aria-describedby={hintId}
						className={cn("text-sm", unit && "pr-14")}
					/>
					{unit && (
						<span
							className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-label text-muted-foreground"
							aria-hidden="true"
						>
							{unit}
						</span>
					)}
				</div>
				{action}
			</div>
			{hint && (
				<p id={hintId} className="text-label leading-relaxed text-muted-foreground">
					{hint}
				</p>
			)}
		</div>
	);
}
