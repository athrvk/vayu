/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The dialogs and flows the palette's commands open.
 *
 * Four commands need something React owns rather than a store: a collection picker, the run dialog,
 * the theme hook and `useCopy` (the one clipboard writer, `clipboard-single-writer.test.ts`). Their
 * hosts are not always on screen (the welcome screen's picker exists only on the welcome tab, and
 * the collections tree's run dialog unmounts when the drawer closes), so the palette hosts its own:
 * the same component the original surface renders, driven by the same call, so a run started here
 * is the run the tree starts.
 *
 * The theme comes from `useElectronTheme`, a thin face over `useThemeStore`: mode, scheme and
 * `isDark` are one value shared with the app shell and the Appearance panel, so a toggle here
 * reaches the panel's radio group and its direction is never read from a stale copy (#1855).
 *
 * Three surfaces are **not** hosted here, and cannot be. Starting a load test and sending need the
 * request builder's live editor draft, which exists only inside a provider the palette is a sibling
 * of, so the mounted builder registers them through `lib/commands/live-surfaces.ts` and this hook
 * merges what is registered: offered while a builder is on screen, absent otherwise. The builder
 * also withdraws Send while it could not send at all, so that row tracks the Send button, not just
 * the builder's presence. A finished load run's export menu registers the third the same way: what
 * an export sends depends on that menu's comparison toggle, in the mounted run view.
 */

import { useCallback, useMemo, useState } from "react";
import { useNewRequest } from "@/hooks/useNewRequest";
import { useElectronTheme } from "@/hooks/useElectronTheme";
import { useCopy } from "@/hooks/useCopy";
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
	const { copy } = useCopy();
	const [runTarget, setRunTarget] = useState<Collection | null>(null);
	const startLoadTest = useLiveCommandSurfaceStore((s) => s.startLoadTest);
	const sendRequest = useLiveCommandSurfaceStore((s) => s.sendRequest);
	const exportRun = useLiveCommandSurfaceStore((s) => s.exportRun);

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
			copy,
			...(startLoadTest ? { startLoadTest } : {}),
			...(sendRequest ? { sendRequest } : {}),
			...(exportRun ? { exportRun } : {}),
		}),
		[newRequest, toggleThemeMode, copy, startLoadTest, sendRequest, exportRun]
	);

	return { surfaces, pickerProps, runTarget, dismissRunDialog };
}
