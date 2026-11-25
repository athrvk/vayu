/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The notification preferences' options (position, duration scale, stack size, severity floor) and
 * their persisted shape. The timings are in `config/timing.ts` (`TOAST_DURATION_MS`,
 * `TOAST_EXIT_MS`) with every UI-facing delay; this file holds what is not a delay.
 */

import type { ToastVariant } from "@/stores/toast-store";
import type { LabeledOption } from "./client-settings";

/**
 * The default stack size; `TOAST_STACK_OPTIONS` offers others. Four is what fits above the fold at
 * the viewport's width without the oldest sliding off the top of the screen; past the size the
 * oldest is dropped, because a toast pushed off-screen is unreachable and undismissable. The same
 * reasoning is why the Notifications panel warns about the larger sizes.
 */
export const MAX_TOASTS = 4;

/* ── Position ────────────────────────────────────────────────────────────── */

export type ToastPosition =
	"bottom-right" | "bottom-left" | "bottom-center" | "top-right" | "top-left" | "top-center";

/**
 * Where the stack anchors, and everything that follows from it.
 *
 * `className` is the whole fixed-position rule, not fragments, because the offsets are not
 * interchangeable: the viewport is `position: fixed`, so it anchors to the window, not the layout,
 * and app chrome occupies both the top and bottom edges of the window. A bottom position clears the
 * Dock and a top one the title row *and* the tab strip under it, so each edge carries its own
 * tokens, never a round number. `toast-position.test.tsx` holds this; a plain `bottom-4` once put
 * the stack on top of the Dock.
 *
 * `swipe` points the dismiss gesture at the nearest window edge: a stack on the left that only
 * dismissed rightwards would be swiped *across* the app. Centre positions swipe toward their own
 * edge, up or down.
 */
export interface ToastPositionOption extends LabeledOption<ToastPosition> {
	readonly swipe: "right" | "left" | "up" | "down";
	readonly className: string;
}

const BOTTOM = "bottom-[calc(var(--dock-height)+1rem)]";
/*
 * Both chrome rows, not just the title bar: the top of the window is the title row and, beside the
 * drawer's header, the tab strip, and a stack that cleared only the first landed on whichever was
 * under it. Every top position crosses at least one: left over the drawer band, centre and right
 * over the tabs.
 */
const TOP = "top-[calc(var(--titlebar-height)+var(--tabstrip-height)+1rem)]";

/*
 * Order matters: this array is rendered straight into a 3-column grid, so the picker reads as a map
 * of the window (top row on top, bottom row underneath, left/centre/right across). Any other order
 * (by name, or default first) puts "Bottom right" in the top-left cell.
 */
export const TOAST_POSITIONS: readonly ToastPositionOption[] = [
	{ value: "top-left", label: "Top left", swipe: "left", className: `${TOP} left-4` },
	{
		value: "top-center",
		label: "Top centre",
		swipe: "up",
		className: `${TOP} left-1/2 -translate-x-1/2`,
	},
	{ value: "top-right", label: "Top right", swipe: "right", className: `${TOP} right-4` },
	{ value: "bottom-left", label: "Bottom left", swipe: "left", className: `${BOTTOM} left-4` },
	{
		value: "bottom-center",
		label: "Bottom centre",
		swipe: "down",
		className: `${BOTTOM} left-1/2 -translate-x-1/2`,
	},
	{
		value: "bottom-right",
		label: "Bottom right",
		swipe: "right",
		className: `${BOTTOM} right-4`,
	},
];

export const DEFAULT_TOAST_POSITION: ToastPosition = "bottom-right";

/** Lookup with a fallback, for a value read back from storage. */
export function toastPositionOption(value: ToastPosition): ToastPositionOption {
	return (
		TOAST_POSITIONS.find((p) => p.value === value) ??
		TOAST_POSITIONS.find((p) => p.value === DEFAULT_TOAST_POSITION)!
	);
}

/* ── Duration ────────────────────────────────────────────────────────────── */

export type ToastDurationScale = "short" | "default" | "long" | "never";

/**
 * A multiplier over `TIMING.TOAST_DURATION_MS`, not a replacement: those durations are per variant
 * on purpose (a confirmation is read at a glance, a failure often names a cause that takes longer),
 * and a flat "5 seconds for everything" would throw that away. Scaling keeps the ratio and still
 * lets a quick reader halve the lot.
 */
export interface ToastDurationOption extends LabeledOption<ToastDurationScale> {
	/** Multiplier applied to the variant's tuned duration. */
	readonly factor: number;
}

export const TOAST_DURATION_SCALES: readonly ToastDurationOption[] = [
	{ value: "short", label: "Short", description: "Half the default", factor: 0.5 },
	{ value: "default", label: "Default", description: "4s to 10s by severity", factor: 1 },
	{ value: "long", label: "Long", description: "Twice the default", factor: 2 },
	{
		value: "never",
		label: "Never",
		description: "Stay until dismissed",
		factor: Number.POSITIVE_INFINITY,
	},
];

export const DEFAULT_TOAST_DURATION_SCALE: ToastDurationScale = "default";

/**
 * Stand-in for "does not auto-dismiss". Not `Infinity`: the primitive arms a real `setTimeout`,
 * which coerces a non-finite delay to 1, the opposite of what was asked. A day is longer than any
 * session and still a number.
 */
export const NEVER_DISMISS_MS = 24 * 60 * 60 * 1000;

/* ── Stack size ──────────────────────────────────────────────────────────── */

export const TOAST_STACK_OPTIONS: readonly LabeledOption<number>[] = [
	{ value: 1, label: "1" },
	{ value: 2, label: "2" },
	{ value: 3, label: "3" },
	{ value: 4, label: "4" },
	{ value: 6, label: "6" },
	{ value: 8, label: "8" },
];

/* ── Severity floor ──────────────────────────────────────────────────────── */

export type ToastSeverityFloor = "all" | "warning" | "error" | "none";

/**
 * Rank per variant, so the floor is one comparison, not four branches. `info` and `success` share a
 * rank on purpose: they differ in tone, not in how much the user needs them, and someone silencing
 * chatter wants both gone.
 */
export const TOAST_SEVERITY_RANK: Record<ToastVariant, number> = {
	info: 0,
	success: 0,
	warning: 1,
	error: 2,
};

export interface ToastSeverityOption extends LabeledOption<ToastSeverityFloor> {
	/** Minimum rank that still gets shown. */
	readonly minRank: number;
	/** Set where choosing this hides something the user probably needs. */
	readonly warn?: string;
}

export const TOAST_SEVERITY_FLOORS: readonly ToastSeverityOption[] = [
	{ value: "all", label: "All", description: "Every notification", minRank: 0 },
	{
		value: "warning",
		label: "Warnings and errors",
		description: "Hides info and success",
		minRank: 1,
	},
	{ value: "error", label: "Errors only", description: "Failures alone", minRank: 2 },
	{
		value: "none",
		label: "None",
		description: "Silence everything",
		minRank: Number.POSITIVE_INFINITY,
		warn: "Errors are hidden too, so a failed request reports nothing anywhere.",
	},
];

export const DEFAULT_TOAST_SEVERITY_FLOOR: ToastSeverityFloor = "all";

/* ── The persisted shape ─────────────────────────────────────────────────── */

export interface NotificationPrefs {
	position: ToastPosition;
	durationScale: ToastDurationScale;
	maxVisible: number;
	minSeverity: ToastSeverityFloor;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
	position: DEFAULT_TOAST_POSITION,
	durationScale: DEFAULT_TOAST_DURATION_SCALE,
	maxVisible: MAX_TOASTS,
	minSeverity: DEFAULT_TOAST_SEVERITY_FLOOR,
};

/** True when a variant clears the configured floor. */
export function passesSeverityFloor(variant: ToastVariant, floor: ToastSeverityFloor): boolean {
	const min = TOAST_SEVERITY_FLOORS.find((f) => f.value === floor)?.minRank ?? 0;
	return TOAST_SEVERITY_RANK[variant] >= min;
}

/** The duration a variant should get under the chosen scale. */
export function scaledDuration(base: number, scale: ToastDurationScale): number {
	const factor =
		TOAST_DURATION_SCALES.find((s) => s.value === scale)?.factor ??
		/* istanbul ignore next */ 1;
	return Number.isFinite(factor) ? Math.round(base * factor) : NEVER_DISMISS_MS;
}
