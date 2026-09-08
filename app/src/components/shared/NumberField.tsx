/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { Input, Label } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * A labelled number input with its unit inside the field.
 *
 * The unit used to live in the label - "Duration (seconds)", "Target RPS
 * (Requests per second)" - which made labels long and repeated the mode name
 * back at the user. `htmlFor`/`id` are wired because these were bare `<Label>`s
 * next to inputs, associated by proximity only.
 *
 * Shared rather than owned by one dialog (issue #1564): `RunCollectionDialog`
 * reuses it for the same pass/fail budget fields `LoadTestConfigDialog`
 * introduced it for, and a hand-rolled copy would not receive this one's
 * fixes.
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
}) {
	const hintId = hint ? `${id}-hint` : undefined;
	return (
		<div className="space-y-1.5">
			<Label htmlFor={id} className="text-xs">
				{label}
				{optional && (
					<span className="ml-1 font-normal text-muted-foreground">(optional)</span>
				)}
			</Label>
			<div className="relative">
				<Input
					id={id}
					type="number"
					inputMode="numeric"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					min={min}
					max={max}
					placeholder={placeholder}
					aria-describedby={hintId}
					className={cn("h-9 text-sm", unit && "pr-14")}
				/>
				{unit && (
					<span
						className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground"
						aria-hidden="true"
					>
						{unit}
					</span>
				)}
			</div>
			{hint && (
				<p id={hintId} className="text-[11px] leading-relaxed text-muted-foreground">
					{hint}
				</p>
			)}
		</div>
	);
}
