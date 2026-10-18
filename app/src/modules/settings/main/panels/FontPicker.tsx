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

import { Input } from "@/components/ui";
import type { FontOption } from "@/constants/appearance";
import { TileGroup, TileItem } from "./SettingControls";

interface FontPickerProps {
	options: readonly FontOption[];
	/** Selected value - a preset's `value` or the literal "custom". */
	value: string;
	onChange: (value: string) => void;
	/** The accessible name of the tile radiogroup: the setting the font is for. */
	label: string;
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
	value,
	selected,
	label,
	description,
	stack,
	sample,
}: {
	value: string;
	selected: boolean;
	label: string;
	description: string;
	stack: string;
	sample: string;
}) {
	return (
		<TileItem
			value={value}
			selected={selected}
			checkClassName="top-2 right-2"
			className="items-start gap-1 p-3 text-left"
		>
			<span className="text-sm font-medium">{label}</span>
			<span className="text-xs text-muted-foreground">{description}</span>
			<span
				className="mt-1.5 text-md leading-tight text-foreground"
				style={{ fontFamily: stack }}
			>
				{sample}
			</span>
		</TileItem>
	);
}

export function FontPicker({
	options,
	value,
	onChange,
	label,
	customValue,
	onCustomChange,
	sample,
	customStack,
	placeholder,
}: FontPickerProps) {
	return (
		<div className="space-y-3">
			<TileGroup value={value} onChange={onChange} label={label} columns="grid-cols-2">
				{options.map((option) => (
					<FontTile
						key={option.value}
						value={option.value}
						selected={value === option.value}
						label={option.label}
						description={option.description}
						stack={option.stack}
						sample={sample}
					/>
				))}
				<FontTile
					value="custom"
					selected={value === "custom"}
					label="Custom…"
					description="Any font installed on your system"
					stack={customStack(customValue)}
					sample={sample}
				/>
			</TileGroup>
			{value === "custom" && (
				<div className="enter-fade">
					<Input
						aria-label={`${label} family`}
						value={customValue}
						onChange={(e) => onCustomChange(e.target.value)}
						placeholder={placeholder}
						className="max-w-sm"
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
