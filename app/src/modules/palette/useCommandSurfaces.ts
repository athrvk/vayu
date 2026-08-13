/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The dialogs and flows the palette's commands open.
 *
 * Three commands need something React owns rather than something a store holds:
 * a collection picker, the run dialog, and the theme hook. Their existing hosts
 * are not always on screen - the welcome screen's picker exists only on the
 * welcome tab, and the collections tree's run dialog is unmounted the moment the
 * drawer closes - so the palette hosts its own. Each is the same component the
 * original surface renders, driven by the same call, so a run started from here
 * is the run the tree starts.
 *
 * The theme comes from `useElectronTheme`, which keeps its state per instance
 * and syncs instances through Electron's `theme-changed` event - so a toggle
 * from here reaches the Appearance panel's radio group the same way an OS theme
 * change does.
 *
 * A fourth surface is **not** hosted here, and cannot be: starting a load test
 * needs the request builder's live editor draft, which exists only inside a
 * provider the palette is a sibling of. The mounted builder contributes it
 * through `lib/commands/live-surfaces.ts` and this hook merges what is
 * registered, so the command is offered while a builder is on screen and absent
 * the rest of the time.
 */

import { useCallback, useMemo, useState } from "react";
import { useNewRequest } from "@/hooks/useNewRequest";
import { useElectronTheme } from "@/hooks/useElectronTheme";
import { useLiveCommandSurfaceStore, type CommandSurfaces } from "@/lib/commands";
import type { Collection } from "@/types";
import type { NewRequestPickerProps } from "@/hooks/useNewRequest";

export interface UseCommandSurfacesReturn {
	surfaces: CommandSurfaces;
	pickerProps: NewRequestPickerProps;
	/** The collection whose run dialog is open, or `null` when none is. */
	runTarget: Collection | null;
	dismissRunDialog: () => void;
}

export function useCommandSurfaces(): UseCommandSurfacesReturn {
	const { newRequest, pickerProps } = useNewRequest();
	const { isDark, setTheme } = useElectronTheme();
	const [runTarget, setRunTarget] = useState<Collection | null>(null);
	const startLoadTest = useLiveCommandSurfaceStore((s) => s.startLoadTest);

	const dismissRunDialog = useCallback(() => setRunTarget(null), []);

	// Light and dark only. "System" is a third *source*, not a third mode, and a
	// toggle that landed on it would leave the user unable to say which way the
	// next press goes - the Appearance panel is where the OS is opted back into.
	const toggleThemeMode = useCallback(
		() => void setTheme(isDark ? "light" : "dark"),
		[isDark, setTheme]
	);

	// Spread rather than assigned: the command's availability asks whether the key
	// is defined, and `startLoadTest: undefined` would answer that correctly today
	// but only by accident of how the check is spelled.
	const surfaces = useMemo<CommandSurfaces>(
		() => ({
			newRequest,
			runCollection: setRunTarget,
			toggleThemeMode,
			...(startLoadTest ? { startLoadTest } : {}),
		}),
		[newRequest, toggleThemeMode, startLoadTest]
	);

	return { surfaces, pickerProps, runTarget, dismissRunDialog };
}
