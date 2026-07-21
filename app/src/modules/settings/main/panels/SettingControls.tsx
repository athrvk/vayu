/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * SettingControls
 *
 * Small shared primitives for the client settings panels so the many
 * pick-one / toggle cards don't each re-implement the same button grid. All use
 * the centralized `--primary` accent for the selected/on state.
 */

import { CheckCircle2 } from "lucide-react";
import { Switch, Label } from "@/components/ui";
import { cn } from "@/lib/utils";

export interface OptionButtonItem<T> {
	value: T;
	label: string;
	description?: string;
}

interface OptionButtonsProps<T extends string | number> {
	options: readonly OptionButtonItem<T>[];
	value: T;
	onChange: (value: T) => void;
	/** Tailwind grid-cols class; defaults to a sensible per-count layout. */
	columns?: string;
}

// Literal classes so Tailwind's scanner emits them (dynamic strings aren't seen).
const COLS: Record<number, string> = {
	1: "grid-cols-1",
	2: "grid-cols-2",
	3: "grid-cols-3",
	4: "grid-cols-4",
	5: "grid-cols-5",
};

export function OptionButtons<T extends string | number>({
	options,
	value,
	onChange,
	columns,
}: OptionButtonsProps<T>) {
	const cols = columns ?? COLS[Math.min(options.length, 5)] ?? "grid-cols-3";
	return (
		<div className={cn("grid gap-3", cols)}>
			{options.map((option) => {
				const isSelected = value === option.value;
				return (
					<button
						key={String(option.value)}
						onClick={() => onChange(option.value)}
						className={cn(
							"relative flex flex-col items-center justify-center gap-0.5 p-3 rounded-lg border-2 text-center transition-all",
							"hover:bg-accent hover:border-accent-foreground/20",
							isSelected ? "border-primary bg-primary/5" : "border-border"
						)}
					>
						<span className={cn("text-sm font-medium", isSelected && "text-primary")}>
							{option.label}
						</span>
						{option.description && (
							<span className="text-xs text-muted-foreground">
								{option.description}
							</span>
						)}
						{isSelected && (
							<CheckCircle2 className="w-4 h-4 text-primary absolute top-1.5 right-1.5" />
						)}
					</button>
				);
			})}
		</div>
	);
}

interface ToggleRowProps {
	label: string;
	description?: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}

export function ToggleRow({ label, description, checked, onChange }: ToggleRowProps) {
	return (
		<div className="flex items-center justify-between gap-4">
			<div className="min-w-0">
				<Label className="text-sm font-medium">{label}</Label>
				{description && (
					<p className="text-xs text-muted-foreground mt-0.5">{description}</p>
				)}
			</div>
			{/*
			 * The visible <Label> is not associated with this control (Radix
			 * renders a button, not an input), so without aria-label the switch
			 * announced as an unnamed toggle. Naming it here fixes every
			 * ToggleRow at once.
			 */}
			<Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
		</div>
	);
}
