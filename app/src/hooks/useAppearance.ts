/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useAppearance Hook
 *
 * Owns the two renderer-only interface preferences — UI font and interface
 * scale — persisting them to localStorage and applying them to the document.
 * Font swaps the `--font-sans` custom property; scale sets the page zoom
 * factor (webFrame in Electron, a CSS `zoom` fallback in the browser). The
 * pre-paint script in index.html applies the same values before React mounts;
 * this hook stays the source of truth once it runs.
 */

import { useCallback, useEffect, useState } from "react";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import {
	DEFAULT_UI_FONT,
	DEFAULT_UI_SCALE,
	fontStack,
	isUiFont,
	isUiScale,
	scaleFactor,
	type UiFont,
	type UiScale,
} from "@/constants/appearance";

function applyFont(font: UiFont): void {
	document.documentElement.style.setProperty("--font-sans", fontStack(font));
}

function applyScale(scale: UiScale): void {
	const factor = scaleFactor(scale);
	if (window.electronAPI?.setZoomFactor) {
		// Real page zoom — reflows the viewport, unlike CSS zoom on a child.
		window.electronAPI.setZoomFactor(factor);
	} else {
		// Browser/dev fallback: good enough to preview, imperfect at the edges.
		document.documentElement.style.zoom = String(factor);
	}
}

function readFont(): UiFont {
	const saved = localStorage.getItem(STORAGE_KEYS.UI_FONT);
	return isUiFont(saved) ? saved : DEFAULT_UI_FONT;
}

function readScale(): UiScale {
	const saved = localStorage.getItem(STORAGE_KEYS.UI_SCALE);
	return isUiScale(saved) ? saved : DEFAULT_UI_SCALE;
}

export function useAppearance() {
	// Seed from localStorage during render (lazy init) so there's no setState in
	// the mount effect; the effect below only re-applies to the DOM, which the
	// pre-paint script already did for the first frame.
	const [font, setFontState] = useState<UiFont>(readFont);
	const [scale, setScaleState] = useState<UiScale>(readScale);

	useEffect(() => {
		applyFont(font);
		applyScale(scale);
		// Mount-only: re-assert the persisted values against the live DOM.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const setFont = useCallback((next: UiFont) => {
		setFontState(next);
		applyFont(next);
		localStorage.setItem(STORAGE_KEYS.UI_FONT, next);
	}, []);

	const setScale = useCallback((next: UiScale) => {
		setScaleState(next);
		applyScale(next);
		localStorage.setItem(STORAGE_KEYS.UI_SCALE, next);
	}, []);

	return { font, setFont, scale, setScale };
}
