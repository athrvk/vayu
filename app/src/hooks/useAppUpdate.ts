/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useCallback, useEffect, useState } from "react";
import { systemNotify, NOTIFY_KINDS } from "@/services/notify";
import { useUpdateVerificationStore } from "@/stores/update-verification-store";
import type { UpdateVerificationFailure } from "@/types/electron";

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
	/**
	 * Silent path only: 0 to 1 while the update is downloading in the
	 * background, **null** before a download starts and once it finishes -
	 * `readyToInstall` is what tells the banner to stop rendering a bar.
	 */
	downloadProgress: number | null;
	/**
	 * Silent path only: the downloaded installer's build-provenance attestation
	 * did not verify (issue #2372), so it will not be installed. Replaces
	 * `readyToInstall` for that version; cleared by the next announcement or
	 * verified download.
	 */
	verificationFailure: UpdateVerificationFailure | null;
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
	const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
	const [dismissed, setDismissed] = useState(false);
	const verificationFailure = useUpdateVerificationStore((s) => s.failure);

	useEffect(() => {
		const api = window.electronAPI;
		if (!api) return;
		const verification = useUpdateVerificationStore.getState();

		const offAvailable = api.onUpdateAvailable((info) => {
			setUpdate(info);
			// A newly announced version is by definition not the downloaded one, on
			// either path. Leaving this true across an announcement let the silent
			// path offer "restart to install" for a version still downloading, and
			// the restart then installs whatever is staged - the previous version on
			// Windows, or a file electron-updater has already deleted on AppImage.
			// `update-downloaded` sets it again for the version the banner names.
			setReadyToInstall(false);
			setDownloadProgress(null);
			verification.clear();
			// Only the notify path (macOS), where this announcement is the whole
			// story: on the silent paths the download that follows is what the
			// user can act on, and notifying twice for one version is noise.
			if (info.strategy === "notify") {
				systemNotify.post({
					kind: NOTIFY_KINDS.updateReady,
					title: `Vayu ${info.version} is available`,
					body: "Open Vayu to install it.",
					target: { view: "settings" },
				});
			}
		});

		const offProgress = api.onDownloadProgress((progress) => {
			setDownloadProgress(progress.percent / 100);
		});

		const offDownloaded = api.onUpdateDownloaded((info) => {
			setUpdate((prev) => (prev ? { ...prev, version: info.version } : null));
			setReadyToInstall(true);
			setDownloadProgress(null);
			// A banner dismissed mid-download is "not right now", not "never tell
			// me it's ready" - the user could not have dismissed a "restart to
			// install" prompt that did not exist yet.
			setDismissed(false);
			verification.clear();
			systemNotify.post({
				kind: NOTIFY_KINDS.updateReady,
				title: `Vayu ${info.version} is ready`,
				body: "Restart Vayu to update.",
				target: { view: "settings" },
			});
		});

		// No system notification: the app's `updateReady` kind says "ready", and
		// this is the opposite. The banner is what a user who is looking sees.
		const offVerificationFailed = api.onUpdateVerificationFailed((failure) => {
			setUpdate((prev) => (prev ? { ...prev, version: failure.version } : null));
			// The main process refuses a restart after a failed verification;
			// offering one here would be a button that does nothing.
			setReadyToInstall(false);
			setDownloadProgress(null);
			setDismissed(false);
			verification.setFailure(failure);
		});

		return () => {
			offAvailable?.();
			offProgress?.();
			offDownloaded?.();
			offVerificationFailed?.();
		};
	}, []);

	const dismiss = useCallback(() => setDismissed(true), []);
	const restartToInstall = useCallback(() => {
		void window.electronAPI?.restartToInstallUpdate();
	}, []);
	const openReleasePage = useCallback(() => {
		if (update) void window.electronAPI?.openReleasePage();
	}, [update]);
	const quitForUpdate = useCallback(() => {
		void window.electronAPI?.quitForUpdate();
	}, []);

	// Only surface once we have something actionable and the user hasn't
	// dismissed it - "actionable" now includes a download already in flight,
	// so the silent path's progress bar shows before the update is ready
	// rather than only once it is. A failed verification is the one outcome
	// that must not be swallowed by the silent path's "nothing to show yet".
	const shouldShow =
		!dismissed &&
		update !== null &&
		(update.strategy === "notify" ||
			readyToInstall ||
			downloadProgress !== null ||
			verificationFailure !== null);

	return {
		update: shouldShow ? update : null,
		readyToInstall,
		downloadProgress,
		verificationFailure,
		dismiss,
		restartToInstall,
		openReleasePage,
		quitForUpdate,
	};
}
