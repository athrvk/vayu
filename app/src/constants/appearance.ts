/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Interface preferences - UI font and interface scale.
 *
 * Both are pure renderer preferences (no OS/Electron theme involvement),
 * persisted to localStorage and applied to the document. This file is the
 * single source of truth: types, the settings controls, and the runtime guards
 * all derive from the arrays (font, radius) and the scale range below. Font
 * stacks reference faces already loaded by index.html (Space Grotesk, JetBrains
 * Mono) or system fonts, so switching never triggers a network fetch.
 */

export interface FontOption {
	readonly value: string;
	readonly label: string;
	readonly description: string;
	readonly stack: string;
}

export const UI_FONTS = [
	{
		value: "grotesk",
		label: "Space Grotesk",
		description: "Default - geometric sans",
		stack: '"Space Grotesk", system-ui, sans-serif',
	},
	{
		value: "inter",
		label: "Inter",
		description: "Neutral, highly legible",
		stack: '"Inter", system-ui, sans-serif',
	},
	{
		value: "system",
		label: "System",
		description: "Your OS interface font",
		stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
	},
	{
		value: "mono",
		label: "JetBrains Mono",
		description: "Monospace throughout",
		stack: '"JetBrains Mono", "Consolas", "Monaco", monospace',
	},
] as const satisfies readonly FontOption[];

/** UI font preference, applied by overriding the `--font-sans` custom property. */
export type UiFont = (typeof UI_FONTS)[number]["value"];
export const DEFAULT_UI_FONT: UiFont = "inter";

/** A preset UI font, or "custom" - a user-typed family (see {@link customSansStack}). */
export type UiFontChoice = UiFont | "custom";

/**
 * Monospace (code) font - applied by overriding the `--font-mono` custom
 * property (Tailwind's `font-mono` utilities read it) and passed to the Monaco
 * editor's `fontFamily`. Stacks reference faces already loaded by index.html
 * (JetBrains Mono) or system fonts, so switching never triggers a fetch.
 */
export const MONO_FONTS = [
	{
		value: "jetbrains",
		label: "JetBrains Mono",
		description: "Default - geometric, wide",
		stack: '"JetBrains Mono", "Consolas", "Monaco", monospace',
	},
	{
		value: "fira",
		label: "Fira Code",
		description: "Rounded, coding ligatures",
		stack: '"Fira Code", "JetBrains Mono", monospace',
	},
	{
		value: "ibm-plex",
		label: "IBM Plex Mono",
		description: "Humanist, softer curves",
		stack: '"IBM Plex Mono", "JetBrains Mono", monospace',
	},
	{
		value: "space-mono",
		label: "Space Mono",
		description: "Retro, distinctive shapes",
		stack: '"Space Mono", "JetBrains Mono", monospace',
	},
	{
		value: "system",
		label: "System Mono",
		description: "Your OS monospace font",
		stack: 'ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace',
	},
] as const satisfies readonly FontOption[];

/** Monospace font preference, applied to `--font-mono` and the code editor. */
export type MonoFont = (typeof MONO_FONTS)[number]["value"];
export const DEFAULT_MONO_FONT: MonoFont = "jetbrains";

/** A preset face, or "custom" - a user-typed family (see {@link customMonoStack}). */
export type MonoFontChoice = MonoFont | "custom";

/**
 * Interface scale - a page-zoom factor (webFrame in Electron), stored as the
 * number itself rather than a preset name. It replaced three fixed steps
 * (Compact 0.9 / Default 1 / Comfortable 1.1), which topped out below the
 * 125-150% accessibility band and left the View menu's Ctrl+/- compounding on
 * top of a setting that then disagreed with the window.
 *
 * The range is stepped, not free: every path that changes it (the settings
 * slider, the menu nudge, a stored value being read back) goes through
 * {@link clampScale}, so the value is always on the grid and inside the bounds.
 */
export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 2;
export const UI_SCALE_STEP = 0.1;
export const DEFAULT_UI_SCALE = 1;

/**
 * The three preset names this setting used to store, mapped to the factors they
 * applied. A stored preset migrates to its factor on read and is rewritten as a
 * number by the next change - a Map, not an object, so a stored `"constructor"`
 * cannot reach `Object.prototype`.
 */
const LEGACY_UI_SCALES = new Map<string, number>([
	["compact", 0.9],
	["default", 1],
	["comfortable", 1.1],
]);

/**
 * Snap a factor onto the step grid and clamp it to the range. The multiply/
 * round is not cosmetic: repeated `+= 0.1` nudges drift (0.7999999999999999),
 * and the drift reaches both the stored string and the zoom factor.
 */
export function clampScale(factor: number): number {
	if (!Number.isFinite(factor)) return DEFAULT_UI_SCALE;
	const stepped = Math.round(factor / UI_SCALE_STEP) * UI_SCALE_STEP;
	const clamped = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, stepped));
	return Math.round(clamped * 100) / 100;
}

/** Read a stored value: a numeric factor, a legacy preset name, or garbage. */
export function parseScale(saved: string | null): number {
	if (saved === null) return DEFAULT_UI_SCALE;
	const legacy = LEGACY_UI_SCALES.get(saved);
	if (legacy !== undefined) return legacy;
	return clampScale(Number.parseFloat(saved));
}

/** Move `steps` grid positions from `current`, holding at either end. */
export function nudgeScale(current: number, steps: number): number {
	return clampScale(current + steps * UI_SCALE_STEP);
}

/** The factor as the percentage every surface shows it as. */
export function formatScale(factor: number): string {
	return `${Math.round(factor * 100)}%`;
}

export interface RadiusOption {
	readonly value: string;
	readonly label: string;
	readonly description: string;
	/** CSS length assigned to --radius (rounded-lg/md/sm derive from it). */
	readonly radius: string;
}

export const UI_RADII = [
	{ value: "square", label: "Square", description: "Sharp corners", radius: "0rem" },
	{ value: "default", label: "Default", description: "Lightly rounded", radius: "0.375rem" },
	{ value: "rounded", label: "Rounded", description: "Softer corners", radius: "0.75rem" },
] as const satisfies readonly RadiusOption[];

/** Corner roundedness, applied by overriding the `--radius` custom property. */
export type UiRadius = (typeof UI_RADII)[number]["value"];
export const DEFAULT_UI_RADIUS: UiRadius = "default";

const FONT_VALUES = new Set<string>(UI_FONTS.map((f) => f.value));
const MONO_FONT_VALUES = new Set<string>(MONO_FONTS.map((f) => f.value));
const RADIUS_VALUES = new Set<string>(UI_RADII.map((r) => r.value));

export function isUiFont(value: unknown): value is UiFont {
	return typeof value === "string" && FONT_VALUES.has(value);
}

export function isUiRadius(value: unknown): value is UiRadius {
	return typeof value === "string" && RADIUS_VALUES.has(value);
}

export function radiusValue(radius: UiRadius): string {
	return (UI_RADII.find((r) => r.value === radius) ?? UI_RADII[1]).radius;
}

export function fontStack(font: UiFont): string {
	return (UI_FONTS.find((f) => f.value === font) ?? UI_FONTS[0]).stack;
}

export function isMonoFont(value: unknown): value is MonoFont {
	return typeof value === "string" && MONO_FONT_VALUES.has(value);
}

export function monoFontStack(font: MonoFont): string {
	return (MONO_FONTS.find((f) => f.value === font) ?? MONO_FONTS[0]).stack;
}

/**
 * Build a CSS font stack from a user-typed family (VS Code-style custom font).
 * A bare family is quoted and given `fallback`; a value that already contains a
 * comma is treated as a complete stack and used verbatim. Empty → `fallback`.
 */
export function customFontStack(family: string, fallback: string): string {
	const fam = family.trim();
	if (!fam) return fallback;
	if (fam.includes(",")) return fam;
	return `"${fam.replace(/["']/g, "")}", ${fallback}`;
}

/** Custom monospace stack, falling back to the default mono faces. */
export function customMonoStack(family: string): string {
	return customFontStack(family, '"JetBrains Mono", "Consolas", "Monaco", monospace');
}

/** Custom UI (sans) stack, falling back to the default sans faces. */
export function customSansStack(family: string): string {
	return customFontStack(family, "Inter, system-ui, sans-serif");
}
