/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * FontPicker
 *
 * Shared font selector for the settings panels: a grid of preset faces (each
 * previewed in its own family) plus a VS Code-style "Custom…" tile that reveals
 * a free-text family field. Used for both the UI font (Appearance) and the code
 * font (Editor) so the two stay consistent.
 */

import { CheckCircle2 } from "lucide-react";
import { Input } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { FontOption } from "@/constants/appearance";

interface FontPickerProps {
	options: readonly FontOption[];
	/** Selected value - a preset's `value` or the literal "custom". */
	value: string;
	onChange: (value: string) => void;
	/** The user-typed family (shown/edited when "custom" is selected). */
	customValue: string;
	onCustomChange: (family: string) => void;
	/** Sample text rendered inside each tile in that face. */
	sample: string;
	/** Builds a CSS stack from the custom family (for the custom tile preview). */
	customStack: (family: string) => string;
	placeholder: string;
}

function FontTile({
	selected,
	onClick,
	label,
	description,
	stack,
	sample,
}: {
	selected: boolean;
	onClick: () => void;
	label: string;
	description: string;
	stack: string;
	sample: string;
}) {
	return (
		<button
			onClick={onClick}
			className={cn(
				"relative flex flex-col items-start gap-1 p-3 rounded-lg border-2 text-left transition-colors",
				"hover:bg-accent hover:border-accent-foreground/20",
				selected ? "border-primary bg-primary/5" : "border-border"
			)}
		>
			<span className="text-sm font-medium">{label}</span>
			<span className="text-xs text-muted-foreground">{description}</span>
			<span
				className="mt-1.5 text-md leading-tight text-foreground"
				style={{ fontFamily: stack }}
			>
				{sample}
			</span>
			{selected && <CheckCircle2 className="w-4 h-4 text-primary absolute top-2 right-2" />}
		</button>
	);
}

export function FontPicker({
	options,
	value,
	onChange,
	customValue,
	onCustomChange,
	sample,
	customStack,
	placeholder,
}: FontPickerProps) {
	return (
		<div className="space-y-3">
			<div className="grid grid-cols-2 gap-3">
				{options.map((option) => (
					<FontTile
						key={option.value}
						selected={value === option.value}
						onClick={() => onChange(option.value)}
						label={option.label}
						description={option.description}
						stack={option.stack}
						sample={sample}
					/>
				))}
				<FontTile
					selected={value === "custom"}
					onClick={() => onChange("custom")}
					label="Custom…"
					description="Any font installed on your system"
					stack={customStack(customValue)}
					sample={sample}
				/>
			</div>
			{value === "custom" && (
				<div>
					<Input
						value={customValue}
						onChange={(e) => onCustomChange(e.target.value)}
						placeholder={placeholder}
						className="max-w-sm"
						spellCheck={false}
						autoComplete="off"
					/>
					<p className="mt-1.5 text-xs text-muted-foreground">
						Type a font family installed on your system. Falls back to the default if it
						isn&apos;t available.
					</p>
				</div>
			)}
		</div>
	);
}
