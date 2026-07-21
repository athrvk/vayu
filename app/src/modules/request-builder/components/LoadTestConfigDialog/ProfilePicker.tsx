/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The four load profiles, as a radio group rather than a `<Select>`.
 *
 * They are four different strategies with four different forms behind them, and
 * a select shows one label at a time — so choosing meant opening a menu and
 * reading options you could not compare. As cards, all four are visible with a
 * line of description each, which also retires most of the old "What will
 * happen" prose.
 *
 * Keyboard follows the WAI-ARIA radio group pattern, which is stricter than it
 * looks: the whole group is **one** Tab stop, arrows move *and* select (wrapping
 * at the ends), and Space selects the focused option. Roving tabindex is what
 * makes the single stop work — anything else would put four stops in the middle
 * of a form.
 */

import { useRef } from "react";
import { cn } from "@/lib/utils";
import { PROFILES, type LoadTestMode } from "./profiles";

export function ProfilePicker({
	value,
	onChange,
	disabled,
}: {
	value: LoadTestMode;
	onChange: (mode: LoadTestMode) => void;
	disabled?: boolean;
}) {
	const groupRef = useRef<HTMLDivElement>(null);

	const move = (delta: number) => {
		const index = PROFILES.findIndex((p) => p.value === value);
		const next = PROFILES[(index + delta + PROFILES.length) % PROFILES.length];
		onChange(next.value);
		// Focus follows selection, which is the point of the pattern — the user
		// is choosing as they arrow, not navigating then committing.
		groupRef.current?.querySelector<HTMLElement>(`[data-profile="${next.value}"]`)?.focus();
	};

	return (
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
			{PROFILES.map((profile) => {
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
							selected
								? "border-primary bg-primary/10"
								: "border-border bg-card hover:bg-accent"
						)}
					>
						<span
							className={cn(
								"text-[12px] font-semibold",
								selected ? "text-primary" : "text-foreground"
							)}
						>
							{profile.label}
						</span>
						<span className="text-[11px] text-muted-foreground leading-snug">
							{profile.description}
						</span>
					</button>
				);
			})}
		</div>
	);
}
