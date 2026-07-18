/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Interface preferences — UI font and interface scale.
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
		description: "Default — geometric sans",
		stack: '"Space Grotesk", system-ui, sans-serif',
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
export const DEFAULT_UI_FONT: UiFont = "grotesk";

export interface ScaleOption {
	readonly value: string;
	readonly label: string;
	readonly description: string;
	readonly factor: number;
}

export const UI_SCALES = [
	{ value: "compact", label: "Compact", description: "90% — fit more on screen", factor: 0.9 },
	{ value: "default", label: "Default", description: "100%", factor: 1 },
	{
		value: "comfortable",
		label: "Comfortable",
		description: "110% — larger and easier",
		factor: 1.1,
	},
] as const satisfies readonly ScaleOption[];

/** Interface scale, applied as a page zoom factor (webFrame in Electron). */
export type UiScale = (typeof UI_SCALES)[number]["value"];
export const DEFAULT_UI_SCALE: UiScale = "default";

const FONT_VALUES = new Set<string>(UI_FONTS.map((f) => f.value));
const SCALE_VALUES = new Set<string>(UI_SCALES.map((s) => s.value));

export function isUiFont(value: unknown): value is UiFont {
	return typeof value === "string" && FONT_VALUES.has(value);
}

export function isUiScale(value: unknown): value is UiScale {
	return typeof value === "string" && SCALE_VALUES.has(value);
}

export function fontStack(font: UiFont): string {
	return (UI_FONTS.find((f) => f.value === font) ?? UI_FONTS[0]).stack;
}

export function scaleFactor(scale: UiScale): number {
	return (UI_SCALES.find((s) => s.value === scale) ?? UI_SCALES[1]).factor;
}
