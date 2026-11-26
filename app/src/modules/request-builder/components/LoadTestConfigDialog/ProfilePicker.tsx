/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The load profiles as a radio group, not a `<Select>`: they are different strategies with
 * different forms, and a select shows one label at a time, so options could not be compared. As
 * cards, all show with a line of description. The list comes from `LOAD_TEST_MODES`, so a new mode
 * adds a card, unless the caller narrows it with `modes` (the collection run, to the three a
 * scenario accepts). A caller whose target is not one request may reword a card with `copy`;
 * `LOAD_TEST_MODES` is not touched, because `loadTestModeLabel` names stored runs on every other
 * screen.
 *
 * Keyboard is the WAI-ARIA radio group pattern: the group is **one** Tab stop, arrows move *and*
 * select (wrapping), and Space selects. Roving tabindex makes the single stop; anything else would
 * put one stop per card in the middle of a form.
 */

import { useRef } from "react";
import { cn } from "@/lib/utils";
import { LOAD_TEST_MODES, type LoadTestModeInfo } from "@/constants/load-test-modes";
import type { LoadTestMode } from "@/types";

export type ProfilePickerCopy = Partial<
	Record<LoadTestMode, Partial<Pick<LoadTestModeInfo, "label" | "description">>>
>;

export function ProfilePicker({
	value,
	onChange,
	disabled,
	modes,
	copy,
}: {
	value: LoadTestMode;
	onChange: (mode: LoadTestMode) => void;
	disabled?: boolean;
	/** The modes to offer, in `LOAD_TEST_MODES` order. Every mode when omitted. */
	modes?: readonly LoadTestMode[];
	/** Per-mode label / description replacements for this caller's target. */
	copy?: ProfilePickerCopy;
}) {
	const groupRef = useRef<HTMLDivElement>(null);
	const options = (
		modes ? LOAD_TEST_MODES.filter((m) => modes.includes(m.value)) : LOAD_TEST_MODES
	).map((m) => ({ ...m, ...copy?.[m.value] }));

	const move = (delta: number) => {
		const index = options.findIndex((p) => p.value === value);
		const next = options[(index + delta + options.length) % options.length];
		onChange(next.value);
		// Focus follows selection, the point of the pattern: the user chooses as they arrow.
		groupRef.current?.querySelector<HTMLElement>(`[data-profile="${next.value}"]`)?.focus();
	};

	return (
		// eslint-disable-next-line jsx-a11y/interactive-supports-focus -- roving tabindex - the radiogroup is never a tab stop, the selected `role="radio"` child carries `tabIndex={0}` and this onKeyDown moves selection and focus together
		<div
			ref={groupRef}
			role="radiogroup"
			aria-label="Load profile"
			className="grid grid-cols-2 gap-2"
			onKeyDown={(e) => {
				if (disabled) return;
				const delta =
					e.key === "ArrowRight" || e.key === "ArrowDown"
						? 1
						: e.key === "ArrowLeft" || e.key === "ArrowUp"
							? -1
							: 0;
				if (delta === 0) return;
				// Arrow keys would otherwise scroll the dialog body.
				e.preventDefault();
				move(delta);
			}}
		>
			{options.map((profile) => {
				const selected = profile.value === value;
				return (
					<button
						key={profile.value}
						type="button"
						role="radio"
						aria-checked={selected}
						data-profile={profile.value}
						disabled={disabled}
						// Roving tabindex: the group is a single Tab stop.
						tabIndex={selected ? 0 : -1}
						onClick={() => onChange(profile.value)}
						className={cn(
							"flex flex-col gap-0.5 rounded-md border px-3 py-2 text-left transition-colors",
							"disabled:opacity-50 disabled:cursor-not-allowed",
							// An odd count leaves the last card alone in a half-empty row.
							"[&:last-child:nth-child(odd)]:col-span-2",
							selected
								? "border-primary bg-primary-tint"
								: "border-border bg-card hover:bg-accent"
						)}
					>
						<span
							className={cn(
								"text-xs font-semibold",
								selected ? "text-primary" : "text-foreground"
							)}
						>
							{profile.label}
						</span>
						<span className="text-label text-muted-foreground leading-snug">
							{profile.description}
						</span>
					</button>
				);
			})}
		</div>
	);
}
