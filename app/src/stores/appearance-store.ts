/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Appearance store
 *
 * The renderer-only interface preferences - UI font, interface scale, corner
 * roundedness - and the single place each one is written. Seeded from
 * localStorage at module load. `useAppearance` re-asserts them against the live
 * DOM on mount; `useMenuActions` bridges the View menu's zoom items into
 * `nudgeScale` / `resetScale`.
 *
 * Why a store rather than `useState` inside the hook: scale now has two inputs.
 * The settings slider and the native Ctrl+= / Ctrl+- / Ctrl+0 accelerators must
 * move the *same* value, and the hook is mounted twice (the app shell and the
 * Appearance panel). Per-instance state let the panel keep reading "100%" while
 * the window rendered 133% - the desync this store exists to remove.
 *
 * Persistence is one localStorage key per preference, written by the action
 * rather than by zustand's `persist`: the pre-paint script in index.html reads
 * those exact keys before React mounts, and `SETTINGS_STORAGE_KEYS` clears them
 * on "Reset app settings".
 */

import { create } from "zustand";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import {
	DEFAULT_UI_FONT,
	DEFAULT_UI_RADIUS,
	DEFAULT_UI_SCALE,
	clampScale,
	customSansStack,
	fontStack,
	isUiFont,
	isUiRadius,
	nudgeScale,
	parseScale,
	radiusValue,
	type UiFontChoice,
	type UiRadius,
} from "@/constants/appearance";

/**
 * localStorage, or null where there is none.
 *
 * The state below is seeded at module load, so an import from a context with no
 * DOM - a node-environment test reaching the `@/stores` barrel - would
 * otherwise throw before a single action ran. index.html's pre-paint script
 * already makes the same concession for these same four preferences
 * ("localStorage unavailable - the hooks apply on mount"): a cosmetic
 * preference degrades to its default rather than taking the renderer down.
 */
function storage(): Storage | null {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

/** Resolve the active UI-font stack (preset or custom family). */
function sansStack(font: UiFontChoice, custom: string): string {
	return font === "custom" ? customSansStack(custom) : fontStack(font);
}

function applyFont(font: UiFontChoice, custom: string): void {
	document.documentElement.style.setProperty("--font-sans", sansStack(font, custom));
}

function applyRadius(radius: UiRadius): void {
	document.documentElement.style.setProperty("--radius", radiusValue(radius));
}

function applyScale(factor: number): void {
	if (window.electronAPI?.setZoomFactor) {
		// Real page zoom - reflows the viewport, unlike CSS zoom on a child.
		window.electronAPI.setZoomFactor(factor);
	} else {
		// Browser/dev fallback: good enough to preview, imperfect at the edges.
		document.documentElement.style.zoom = String(factor);
	}
}

function readFont(): UiFontChoice {
	const saved = storage()?.getItem(STORAGE_KEYS.UI_FONT) ?? null;
	if (saved === "custom" || isUiFont(saved)) return saved;
	return DEFAULT_UI_FONT;
}

function readFontCustom(): string {
	return storage()?.getItem(STORAGE_KEYS.UI_FONT_CUSTOM) ?? "";
}

function readRadius(): UiRadius {
	const saved = storage()?.getItem(STORAGE_KEYS.UI_RADIUS) ?? null;
	return isUiRadius(saved) ? saved : DEFAULT_UI_RADIUS;
}

interface AppearanceState {
	font: UiFontChoice;
	/** User-typed family, used when `font === "custom"`. */
	fontCustom: string;
	/** Page-zoom factor, always on the step grid (see `clampScale`). */
	scale: number;
	radius: UiRadius;

	setFont: (next: UiFontChoice) => void;
	setFontCustom: (next: string) => void;
	/** Set the zoom factor. Off-grid and out-of-range input is clamped, not refused. */
	setScale: (next: number) => void;
	/** Move the zoom factor `steps` positions - the View menu's Ctrl+= / Ctrl+-. */
	nudgeScale: (steps: number) => void;
	/** Ctrl+0. Returns to 100%, which *is* the default setting, not a bypass of it. */
	resetScale: () => void;
	setRadius: (next: UiRadius) => void;
	/** Re-assert every preference against the live DOM (mount only). */
	applyAll: () => void;
}

export const useAppearanceStore = create<AppearanceState>((set, get) => ({
	font: readFont(),
	fontCustom: readFontCustom(),
	scale: parseScale(storage()?.getItem(STORAGE_KEYS.UI_SCALE) ?? null),
	radius: readRadius(),

	setFont: (next) => {
		set({ font: next });
		applyFont(next, get().fontCustom);
		storage()?.setItem(STORAGE_KEYS.UI_FONT, next);
	},

	setFontCustom: (next) => {
		set({ fontCustom: next });
		storage()?.setItem(STORAGE_KEYS.UI_FONT_CUSTOM, next);
		// Only re-apply live when the custom family is the active choice.
		if (get().font === "custom") applyFont("custom", next);
	},

	setScale: (next) => {
		const factor = clampScale(next);
		set({ scale: factor });
		applyScale(factor);
		storage()?.setItem(STORAGE_KEYS.UI_SCALE, String(factor));
	},

	nudgeScale: (steps) => get().setScale(nudgeScale(get().scale, steps)),

	resetScale: () => get().setScale(DEFAULT_UI_SCALE),

	setRadius: (next) => {
		set({ radius: next });
		applyRadius(next);
		storage()?.setItem(STORAGE_KEYS.UI_RADIUS, next);
	},

	applyAll: () => {
		const { font, fontCustom, scale, radius } = get();
		applyFont(font, fontCustom);
		applyScale(scale);
		applyRadius(radius);
	},
}));
