/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useAppearance Hook
 *
 * React face of {@link useAppearanceStore} - the renderer-only interface
 * preferences (UI font, interface scale, corner roundedness). The store owns
 * the values, the persistence and the DOM writes; this hook only re-asserts
 * them against the live DOM on mount.
 *
 * The View menu's Ctrl+= / Ctrl+- / Ctrl+0 drive the same scale setting, but
 * they are bridged in `useMenuActions` rather than here: this hook is mounted
 * twice (the app shell and the Appearance panel) and a second subscription
 * would move the zoom two steps per keypress.
 *
 * The pre-paint script in index.html applies the same values before React
 * mounts; the store stays the source of truth once it runs.
 */

import { useEffect } from "react";
import { useAppearanceStore } from "@/stores";

export function useAppearance() {
	const font = useAppearanceStore((s) => s.font);
	const fontCustom = useAppearanceStore((s) => s.fontCustom);
	const scale = useAppearanceStore((s) => s.scale);
	const radius = useAppearanceStore((s) => s.radius);
	const setFont = useAppearanceStore((s) => s.setFont);
	const setFontCustom = useAppearanceStore((s) => s.setFontCustom);
	const setScale = useAppearanceStore((s) => s.setScale);
	const setRadius = useAppearanceStore((s) => s.setRadius);

	useEffect(() => {
		// Mount-only: re-assert the persisted values against the live DOM, which
		// the pre-paint script already did for the first frame.
		useAppearanceStore.getState().applyAll();
	}, []);

	return { font, setFont, fontCustom, setFontCustom, scale, setScale, radius, setRadius };
}
