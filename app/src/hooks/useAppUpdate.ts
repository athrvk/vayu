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
	/** macOS notify path: quit so the copied installer command can replace the app. */
	quitForUpdate: () => void;
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
			// A newly announced version is by definition not the downloaded one, on
			// either path. Leaving this true across an announcement let the silent
			// path offer "restart to install" for a version still downloading, and
			// the restart then installs whatever is staged - the previous version on
			// Windows, or a file electron-updater has already deleted on AppImage.
			// `update-downloaded` sets it again for the version the banner names.
			setReadyToInstall(false);
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
	const quitForUpdate = useCallback(() => {
		void window.electronAPI?.quitForUpdate();
	}, []);

	// Only surface once we have something actionable and the user hasn't dismissed it.
	const shouldShow =
		!dismissed && update !== null && (update.strategy === "notify" || readyToInstall);

	return {
		update: shouldShow ? update : null,
		readyToInstall,
		dismiss,
		restartToInstall,
		openReleasePage,
		quitForUpdate,
	};
}
