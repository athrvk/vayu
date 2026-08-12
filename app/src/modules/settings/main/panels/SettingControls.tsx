/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * SettingControls
 *
 * Small shared primitives for the settings panels so the many pick-one / toggle
 * / numeric rows don't each re-implement the same markup. All use the
 * centralized `--primary` accent for the selected/on state.
 */

import { useId, useState, type ReactNode } from "react";
import { CheckCircle2 } from "lucide-react";
import { Button, Input, Switch, Label } from "@/components/ui";
import { cn } from "@/lib/utils";

export interface OptionButtonItem<T> {
	value: T;
	label: string;
	description?: string;
	/**
	 * Rendered above the label - a swatch, an icon badge, a shape preview.
	 *
	 * A function rather than a node because every existing preview restyles
	 * itself when selected (the theme tiles fill their icon badge, the accent
	 * swatches take a ring), and re-implementing the card just to change that
	 * one element is how three copies of this button appeared in the first
	 * place.
	 */
	preview?: (isSelected: boolean) => ReactNode;
}

interface OptionButtonsProps<T extends string | number> {
	options: readonly OptionButtonItem<T>[];
	value: T;
	onChange: (value: T) => void;
	/** Tailwind grid-cols class; defaults to a sensible per-count layout. */
	columns?: string;
	/** `start` left-aligns the tile's contents (the roundedness previews). */
	align?: "center" | "start";
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
	align = "center",
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
							"relative flex flex-col gap-0.5 p-3 rounded-lg border-2 transition-colors",
							align === "center"
								? "items-center justify-center text-center"
								: "items-start text-left",
							"hover:bg-accent hover:border-accent-foreground/20",
							isSelected ? "border-primary bg-primary/5" : "border-border"
						)}
					>
						{option.preview && (
							<span className="mb-1.5 flex items-center justify-center">
								{option.preview(isSelected)}
							</span>
						)}
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
	/**
	 * A node, not just a string, so a row can carry an inline count or a code
	 * span (the MCP tool rows) without hand-rolling the row around it.
	 */
	label: ReactNode;
	/** Required when `label` is not a plain string, so the switch keeps a name. */
	ariaLabel?: string;
	/**
	 * `data-setting-anchor` for this row - the id a search result reveals, as on
	 * {@link NumberSettingRow}. Only rows declared in the app-settings catalogue
	 * need one.
	 */
	anchor?: string;
	description?: ReactNode;
	checked: boolean;
	onChange: (checked: boolean) => void;
	disabled?: boolean;
	/** Native tooltip on the switch (the MCP group toggles use it). */
	title?: string;
	className?: string;
}

export function ToggleRow({
	label,
	ariaLabel,
	anchor,
	description,
	checked,
	onChange,
	disabled,
	title,
	className,
}: ToggleRowProps) {
	const name = ariaLabel ?? (typeof label === "string" ? label : undefined);
	return (
		// `data-setting-row` names the row's box from the same string the switch
		// is named by, as on {@link NumberSettingRow} - one writer, so a consumer
		// or a test never has to read it back out of the markup.
		<div
			className={cn("flex items-center justify-between gap-4", className)}
			data-setting-row={name}
			data-setting-anchor={anchor}
		>
			<div className="min-w-0">
				{typeof label === "string" ? (
					<Label className="text-sm font-medium">{label}</Label>
				) : (
					label
				)}
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
			<Switch
				checked={checked}
				onCheckedChange={onChange}
				disabled={disabled}
				title={title}
				aria-label={name}
				className="shrink-0"
			/>
		</div>
	);
}

interface DefaultValueLineProps {
	/** The setting's default, as stored. */
	defaultValue: string;
	/** The value on screen; the line hides when the two agree. */
	value: string;
	/** How the default reads (a byte count as "1 MB"); falls back to `defaultValue`. */
	display?: string;
	/** Omit for a setting with no way back (nothing in Settings, today). */
	onReset?: () => void;
}

/**
 * "Default: x", with the way back to it.
 *
 * One definition because every row type needs it - the numeric row below, and
 * the boolean/enum/string engine cards. Before this, the engine cards printed
 * the line with no reset next to it and the app rows had neither.
 */
export function DefaultValueLine({ defaultValue, value, display, onReset }: DefaultValueLineProps) {
	if (defaultValue === value) return null;
	return (
		<div className="flex items-center gap-2">
			<p className="text-xs text-muted-foreground">Default: {display ?? defaultValue}</p>
			{onReset && (
				<Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onReset}>
					Reset
				</Button>
			)}
		</div>
	);
}

/**
 * When a typed value reaches the owner of the setting.
 *
 * `change` is for settings that apply live (a chart window, a ceiling the next
 * dialog reads); `blur` is for the ones whose owner does real work on every
 * write (the MCP caps go over IPC and are re-sanitized). Either way an
 * unparseable draft - an emptied field mid-edit - is never committed: it stays
 * in the input until it is a number again, instead of reaching a store that
 * would clamp it to its floor.
 */
export type NumberCommitStrategy = "change" | "blur";

interface NumberSettingRowProps {
	label: string;
	/**
	 * `data-setting-anchor` for this row - the id a search result reveals. Only
	 * rows declared in the app-settings catalogue need one.
	 */
	anchor?: string;
	/**
	 * Keeps the label as the input's accessible name without printing it - for
	 * the engine cards, where the CardTitle above already says it and a visible
	 * second copy would read it out twice.
	 */
	labelHidden?: boolean;
	description?: ReactNode;
	/** The committed value. Shown whenever the field is not mid-edit. */
	value: string;
	/**
	 * Fires per `commit`. Receives the raw string (always parseable as a
	 * number); the owner still decides what to do with it - clamping included.
	 */
	onCommit?: (value: string) => void;
	commit?: NumberCommitStrategy;
	/** Every keystroke, parseable or not - for owners that stage and validate. */
	onDraftChange?: (value: string) => void;
	/** Suffix inside the input. Units live here, once - not in the label. */
	unit?: string;
	min?: string;
	max?: string;
	/** Overrides the range hint derived from min/max (byte ranges format their own). */
	rangeHint?: string;
	/** Validation message from the owner; also drives `aria-invalid`. */
	error?: string;
	/** The setting's default. The Default line renders when `value` differs from it. */
	defaultValue?: string;
	/** How that default reads (a byte count as "1 MB"); falls back to `defaultValue`. */
	defaultDisplay?: string;
	/** Renders the reset control beside the Default line. */
	onResetToDefault?: () => void;
	disabled?: boolean;
	/** Integers only (`step=1`); the engine's `number` entries pass false. */
	integer?: boolean;
}

function derivedRangeHint(min?: string, max?: string): string | null {
	if (min && max) return `${min} - ${max}`;
	if (min) return `Min: ${min}`;
	if (max) return `Max: ${max}`;
	return null;
}

/**
 * The number row: input, unit suffix, range hint, validation, Default line.
 *
 * This shape existed four times over - the engine entry cards, the dashboard
 * SLO threshold, the load-test ceilings and the MCP caps - with divergent
 * markup *and* divergent behaviour (immediate commit, clamp-on-blur, debounce,
 * explicit save). A hand-rolled copy of a primitive does not receive the
 * primitive's fixes, so the four are one component with the commit strategy as
 * a prop.
 */
export function NumberSettingRow({
	label,
	anchor,
	labelHidden = false,
	description,
	value,
	onCommit,
	commit = "blur",
	onDraftChange,
	unit,
	min,
	max,
	rangeHint,
	error,
	defaultValue,
	defaultDisplay,
	onResetToDefault,
	disabled,
	integer = true,
}: NumberSettingRowProps) {
	// Held here so the field shows what was typed even while it is not a number
	// the owner would accept. Cleared on blur, which is what lets a clamped or
	// rejected value snap back to the committed one.
	const [draft, setDraft] = useState<string | null>(null);
	// Whether the field is being typed in right now, tracked as state because the
	// render below has to consult it (a ref cannot be read during render).
	const [focused, setFocused] = useState(false);
	const inputId = useId();
	const errorId = `${inputId}-error`;

	/*
	 * A value that changes from outside while the field is not being typed in -
	 * a Revert, a Reset, a store the panel wrote elsewhere - replaces the draft.
	 * Without this the row kept showing the number that was just reverted away.
	 *
	 * Gated on focus rather than on where the change came from: while the user
	 * is typing, their draft outranks anything the owner echoes back, which is
	 * what stops a store that clamps on every commit from rewriting the field
	 * mid-number.
	 */
	const [lastValue, setLastValue] = useState(value);
	if (lastValue !== value) {
		setLastValue(value);
		if (draft !== null && !focused) setDraft(null);
	}

	const shown = draft ?? value;
	const hint = rangeHint ?? derivedRangeHint(min, max);

	const isCommittable = (raw: string): boolean => {
		const n = integer ? parseInt(raw, 10) : parseFloat(raw);
		return !Number.isNaN(n) && String(raw).trim() !== "";
	};

	const handleChange = (raw: string) => {
		setDraft(raw);
		onDraftChange?.(raw);
		if (commit === "change" && isCommittable(raw)) onCommit?.(raw);
	};

	const handleBlur = () => {
		if (draft === null) return;
		if (commit === "blur" && isCommittable(draft) && draft !== value) onCommit?.(draft);
		setDraft(null);
	};

	return (
		// `data-setting-row` names the row's box: the input, its hint, its error
		// and its Default line are siblings, and without a named container a
		// consumer (or a test) is left guessing at `closest("div")`.
		<div className="space-y-1.5" data-setting-row={label} data-setting-anchor={anchor}>
			<Label
				htmlFor={inputId}
				className={cn("text-sm font-medium", labelHidden && "sr-only")}
			>
				{label}
			</Label>
			<div className="flex items-center gap-2">
				<div className="relative">
					<Input
						id={inputId}
						type="number"
						inputMode="numeric"
						value={shown}
						min={min}
						max={max}
						step={integer ? 1 : "any"}
						disabled={disabled}
						onChange={(e) => handleChange(e.target.value)}
						onFocus={() => setFocused(true)}
						onBlur={() => {
							setFocused(false);
							handleBlur();
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") e.currentTarget.blur();
						}}
						className={cn(
							"max-w-[12rem]",
							// Literal classes, not a computed string: Tailwind's
							// scanner cannot see one that is assembled at runtime.
							unit && (unit.length > 4 ? "pr-20" : "pr-12"),
							error && "border-destructive"
						)}
						/*
						 * Out-of-range values used to be signalled by a red border and a
						 * line of text sitting loose beside the field - colour alone, and
						 * a message the field did not point at. `|| undefined` so valid
						 * fields carry no attribute at all rather than a misleading
						 * aria-invalid="false" on every row on the screen.
						 */
						aria-invalid={error ? true : undefined}
						aria-describedby={error ? errorId : undefined}
					/>
					{unit && (
						<span
							className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground"
							aria-hidden="true"
						>
							{unit}
						</span>
					)}
				</div>
				{hint && (
					<span className="text-xs text-muted-foreground whitespace-nowrap">{hint}</span>
				)}
			</div>
			{error && (
				<p id={errorId} className="text-xs text-destructive-text">
					{error}
				</p>
			)}
			{description && <p className="text-xs text-muted-foreground">{description}</p>}
			{defaultValue !== undefined && (
				<DefaultValueLine
					defaultValue={defaultValue}
					value={value}
					display={defaultDisplay}
					onReset={
						onResetToDefault &&
						(() => {
							// Drop the draft too, or the field would keep showing the
							// number that was just reset away.
							setDraft(null);
							onResetToDefault();
						})
					}
				/>
			)}
		</div>
	);
}
