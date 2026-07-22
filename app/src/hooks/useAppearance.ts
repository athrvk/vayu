/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useAppearance Hook
 *
 * Owns the renderer-only interface preferences - UI font, interface scale, and
 * corner roundedness - persisting them to localStorage and applying them to the
 * document. Font swaps the `--font-sans` custom property; radius swaps
 * `--radius`; scale sets the page zoom factor (webFrame in Electron, a CSS
 * `zoom` fallback in the browser). The pre-paint script in index.html applies
 * the same values before React mounts; this hook stays the source of truth
 * once it runs.
 */

import { useCallback, useEffect, useState } from "react";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import {
	DEFAULT_UI_FONT,
	DEFAULT_UI_RADIUS,
	DEFAULT_UI_SCALE,
	fontStack,
	customSansStack,
	isUiFont,
	isUiRadius,
	isUiScale,
	radiusValue,
	scaleFactor,
	type UiFontChoice,
	type UiRadius,
	type UiScale,
} from "@/constants/appearance";

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

function applyScale(scale: UiScale): void {
	const factor = scaleFactor(scale);
	if (window.electronAPI?.setZoomFactor) {
		// Real page zoom - reflows the viewport, unlike CSS zoom on a child.
		window.electronAPI.setZoomFactor(factor);
	} else {
		// Browser/dev fallback: good enough to preview, imperfect at the edges.
		document.documentElement.style.zoom = String(factor);
	}
}

function readFont(): UiFontChoice {
	const saved = localStorage.getItem(STORAGE_KEYS.UI_FONT);
	if (saved === "custom" || isUiFont(saved)) return saved;
	return DEFAULT_UI_FONT;
}

function readFontCustom(): string {
	return localStorage.getItem(STORAGE_KEYS.UI_FONT_CUSTOM) ?? "";
}

function readScale(): UiScale {
	const saved = localStorage.getItem(STORAGE_KEYS.UI_SCALE);
	return isUiScale(saved) ? saved : DEFAULT_UI_SCALE;
}

function readRadius(): UiRadius {
	const saved = localStorage.getItem(STORAGE_KEYS.UI_RADIUS);
	return isUiRadius(saved) ? saved : DEFAULT_UI_RADIUS;
}

export function useAppearance() {
	// Seed from localStorage during render (lazy init) so there's no setState in
	// the mount effect; the effect below only re-applies to the DOM, which the
	// pre-paint script already did for the first frame.
	const [font, setFontState] = useState<UiFontChoice>(readFont);
	const [fontCustom, setFontCustomState] = useState<string>(readFontCustom);
	const [scale, setScaleState] = useState<UiScale>(readScale);
	const [radius, setRadiusState] = useState<UiRadius>(readRadius);

	useEffect(() => {
		applyFont(font, fontCustom);
		applyScale(scale);
		applyRadius(radius);
		// Mount-only: re-assert the persisted values against the live DOM.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const setFont = useCallback(
		(next: UiFontChoice) => {
			setFontState(next);
			applyFont(next, fontCustom);
			localStorage.setItem(STORAGE_KEYS.UI_FONT, next);
		},
		[fontCustom]
	);

	const setFontCustom = useCallback(
		(next: string) => {
			setFontCustomState(next);
			localStorage.setItem(STORAGE_KEYS.UI_FONT_CUSTOM, next);
			// Only re-apply live when the custom family is the active choice.
			if (font === "custom") applyFont("custom", next);
		},
		[font]
	);

	const setScale = useCallback((next: UiScale) => {
		setScaleState(next);
		applyScale(next);
		localStorage.setItem(STORAGE_KEYS.UI_SCALE, next);
	}, []);

	const setRadius = useCallback((next: UiRadius) => {
		setRadiusState(next);
		applyRadius(next);
		localStorage.setItem(STORAGE_KEYS.UI_RADIUS, next);
	}, []);

	return { font, setFont, fontCustom, setFontCustom, scale, setScale, radius, setRadius };
}
