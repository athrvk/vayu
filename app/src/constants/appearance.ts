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
 * persisted to localStorage and applied to the document. These arrays are the
 * single source of truth: types, the settings picker, and the runtime guards
 * all derive from them. Font stacks reference faces already loaded by
 * index.html (Space Grotesk, JetBrains Mono) or system fonts, so switching
 * never triggers a network fetch.
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

export interface ScaleOption {
	readonly value: string;
	readonly label: string;
	readonly description: string;
	readonly factor: number;
}

export const UI_SCALES = [
	{ value: "compact", label: "Compact", description: "90% - fit more on screen", factor: 0.9 },
	{ value: "default", label: "Default", description: "100%", factor: 1 },
	{
		value: "comfortable",
		label: "Comfortable",
		description: "110% - larger and easier",
		factor: 1.1,
	},
] as const satisfies readonly ScaleOption[];

/** Interface scale, applied as a page zoom factor (webFrame in Electron). */
export type UiScale = (typeof UI_SCALES)[number]["value"];
export const DEFAULT_UI_SCALE: UiScale = "default";

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
const SCALE_VALUES = new Set<string>(UI_SCALES.map((s) => s.value));
const RADIUS_VALUES = new Set<string>(UI_RADII.map((r) => r.value));

export function isUiFont(value: unknown): value is UiFont {
	return typeof value === "string" && FONT_VALUES.has(value);
}

export function isUiScale(value: unknown): value is UiScale {
	return typeof value === "string" && SCALE_VALUES.has(value);
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

export function scaleFactor(scale: UiScale): number {
	return (UI_SCALES.find((s) => s.value === scale) ?? UI_SCALES[1]).factor;
}
