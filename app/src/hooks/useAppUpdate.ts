/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useCallback, useEffect, useState } from "react";

interface AvailableUpdate {
	version: string;
	strategy: "silent" | "notify" | "disabled";
	releaseUrl: string;
	installCommand?: string;
}

interface AppUpdateState {
	/** A newer version exists (notify path) or has been downloaded (silent path). */
	update: AvailableUpdate | null;
	/** Silent path only: the update is downloaded and ready to install on restart. */
	readyToInstall: boolean;
	dismiss: () => void;
	restartToInstall: () => void;
	openReleasePage: () => void;
}

/**
 * Subscribes to main-process auto-update events and exposes the state the
 * update banner renders from. No-op outside Electron.
 */
export function useAppUpdate(): AppUpdateState {
	const [update, setUpdate] = useState<AvailableUpdate | null>(null);
	const [readyToInstall, setReadyToInstall] = useState(false);
	const [dismissed, setDismissed] = useState(false);

	useEffect(() => {
		const api = window.electronAPI;
		if (!api) return;

		const offAvailable = api.onUpdateAvailable((info) => {
			setUpdate(info);
			// Silent path downloads in the background; wait for update-downloaded.
			// Notify path surfaces immediately.
			if (info.strategy === "notify") {
				setReadyToInstall(false);
			}
		});

		const offDownloaded = api.onUpdateDownloaded((info) => {
			setUpdate((prev) => (prev ? { ...prev, version: info.version } : null));
			setReadyToInstall(true);
		});

		return () => {
			offAvailable?.();
			offDownloaded?.();
		};
	}, []);

	const dismiss = useCallback(() => setDismissed(true), []);
	const restartToInstall = useCallback(() => {
		void window.electronAPI?.restartToInstallUpdate();
	}, []);
	const openReleasePage = useCallback(() => {
		if (update) void window.electronAPI?.openReleasePage(update.releaseUrl);
	}, [update]);

	// Only surface once we have something actionable and the user hasn't dismissed it.
	const shouldShow =
		!dismissed && update !== null && (update.strategy === "notify" || readyToInstall);

	return {
		update: shouldShow ? update : null,
		readyToInstall,
		dismiss,
		restartToInstall,
		openReleasePage,
	};
}
