/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useCallback, useEffect, useState } from "react";
import { systemNotify, NOTIFY_KINDS } from "@/services/notify";
import { useUpdateVerificationStore } from "@/stores/update-verification-store";
import type { UpdateDownloadState, UpdateVerificationFailure } from "@/types/electron";

interface AvailableUpdate {
	version: string;
	strategy: "silent" | "notify" | "disabled";
	releaseUrl: string;
	installCommand?: string;
}

/** A download that stopped on an error (issue #3338); the same attempt can be started again. */
interface UpdateDownloadFailure {
	version: string;
	error: string;
}

interface AppUpdateState {
	/** A newer version exists (notify path) or has been downloaded (silent path). */
	update: AvailableUpdate | null;
	/** Silent path only: the update is downloaded and ready to install on restart. */
	readyToInstall: boolean;
	/**
	 * Silent path only: 0 to 1 while the update is downloading in the
	 * background (1 while its installer is being verified), **null** before a
	 * download reports progress and once it ends, whichever way -
	 * `readyToInstall` is what tells the banner to stop rendering a bar.
	 */
	downloadProgress: number | null;
	/**
	 * Silent path only: a download is in flight and the banner should say so. True
	 * wherever `downloadProgress` is known, and also - after a failure - for a
	 * retried download that has not reported a tick yet, when the progress is
	 * still null. A first download stays hidden until it has a tick to show.
	 */
	downloading: boolean;
	/**
	 * Silent path only: the downloaded installer's build-provenance attestation
	 * did not verify (issue #2372), so it will not be installed. Replaces
	 * `readyToInstall` for that version; cleared by the next announcement or
	 * verified download.
	 */
	verificationFailure: UpdateVerificationFailure | null;
	/** Silent path only: the download itself failed (issue #3338). */
	downloadFailure: UpdateDownloadFailure | null;
	dismiss: () => void;
	restartToInstall: () => void;
	openReleasePage: () => void;
	/** macOS notify path: quit so the copied installer command can replace the app. */
	quitForUpdate: () => void;
}

const NO_DOWNLOAD: UpdateDownloadState = { kind: "none" };

function progressOf(download: UpdateDownloadState): number | null {
	if (download.kind === "verifying") return 1;
	if (download.kind !== "downloading" || !download.progress) return null;
	return download.progress.percent / 100;
}

/**
 * The update the banner names. The download state is the authority on the
 * version, and the only record of it after a reload: `update:available` is not
 * replayed, so a renderer that mounts with a download already `verified` or
 * `failed` has no announcement to name it from. The synthesized `releaseUrl` is
 * empty because nothing in the renderer reads it - `openReleasePage` is
 * answered by the main process from the URL the updater offered.
 */
function currentUpdate(
	available: AvailableUpdate | null,
	download: UpdateDownloadState
): AvailableUpdate | null {
	if (download.kind === "none") return available;
	if (!available) return { version: download.version, strategy: "silent", releaseUrl: "" };
	return { ...available, version: download.version };
}

function notifyReady(version: string): void {
	systemNotify.post({
		kind: NOTIFY_KINDS.updateReady,
		title: `Vayu ${version} is ready`,
		body: "Restart Vayu to update.",
		target: { view: "settings" },
	});
}

/**
 * Subscribes to main-process auto-update events and exposes the state the
 * update banner renders from. No-op outside Electron.
 *
 * The silent path's download is read from the main process's single
 * `UpdateDownloadState` (issue #3338): fetched once on mount, so a reloaded
 * renderer still offers a verified update, then followed through
 * `update:state`. `update:available` still supplies what the state does not
 * carry (strategy, install command). A snapshot read on mount never notifies;
 * only a live arrival in `verified` does, so a reload does not announce the same
 * update again. `dismissed` is not part of the snapshot and resets on reload.
 */
export function useAppUpdate(): AppUpdateState {
	const [available, setAvailable] = useState<AvailableUpdate | null>(null);
	const [download, setDownload] = useState<UpdateDownloadState>(NO_DOWNLOAD);
	const [dismissed, setDismissed] = useState(false);
	// A download failed and has not reached an outcome since: the user has seen
	// the failure, so the retry that follows keeps the banner up.
	const [afterFailure, setAfterFailure] = useState(false);
	const verificationFailure = useUpdateVerificationStore((s) => s.failure);

	useEffect(() => {
		const api = window.electronAPI;
		if (!api) return;
		const verification = useUpdateVerificationStore.getState();
		let unmounted = false;
		let pushed = false;
		let previous: UpdateDownloadState = NO_DOWNLOAD;

		const apply = (next: UpdateDownloadState, live: boolean) => {
			const wasVerified = previous.kind === "verified";
			previous = next;
			setDownload(next);
			if (next.kind === "failed") setAfterFailure(true);
			if (next.kind === "none" || next.kind === "verified" || next.kind === "refused") {
				setAfterFailure(false);
			}
			if (next.kind === "refused") {
				verification.setFailure({ version: next.version, reason: next.reason });
			} else {
				verification.clear();
			}
			if (!live) return;
			if (next.kind === "verified" && !wasVerified) notifyReady(next.version);
			// A banner dismissed mid-download is "not right now": the user could not
			// have dismissed an outcome that did not exist yet.
			if (next.kind === "verified" || next.kind === "refused" || next.kind === "failed") {
				setDismissed(false);
			}
		};

		const offAvailable = api.onUpdateAvailable((info) => {
			setAvailable(info);
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

		const offState = api.onUpdateState((next) => {
			pushed = true;
			apply(next, true);
		});

		void api.getUpdateState().then((snapshot) => {
			// A push that landed first is newer than this answer.
			if (unmounted || pushed) return;
			apply(snapshot, false);
		});

		return () => {
			unmounted = true;
			offAvailable?.();
			offState?.();
		};
	}, []);

	const update = currentUpdate(available, download);
	const readyToInstall = download.kind === "verified";
	const downloadProgress = progressOf(download);
	const downloading =
		downloadProgress !== null || (afterFailure && download.kind === "downloading");
	const downloadFailure =
		download.kind === "failed" ? { version: download.version, error: download.error } : null;

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
	// rather than only once it is. A failed verification or download is the
	// outcome that must not be swallowed by the silent path's "nothing to show
	// yet".
	const shouldShow =
		!dismissed &&
		update !== null &&
		(update.strategy === "notify" ||
			readyToInstall ||
			downloading ||
			verificationFailure !== null ||
			downloadFailure !== null);

	return {
		update: shouldShow ? update : null,
		readyToInstall,
		downloadProgress,
		downloading,
		verificationFailure,
		downloadFailure,
		dismiss,
		restartToInstall,
		openReleasePage,
		quitForUpdate,
	};
}
