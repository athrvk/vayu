/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import {
	ArrowUpCircle,
	Check,
	Copy,
	ExternalLink,
	Power,
	RefreshCw,
	RotateCw,
	X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { IconSwap } from "@/components/ui/icon-swap";
import { LabelSwap } from "@/components/ui/label-swap";
import { Progress } from "@/components/ui/progress";
import { useAppUpdate } from "@/hooks/useAppUpdate";
import { useCopy } from "@/hooks/useCopy";
import type { UpdateVerificationFailure } from "@/types/electron";

/**
 * The banner's line; a failure beats every other state, being the one outcome the user must act on,
 * its reason what they need.
 */
function bannerMessage(
	update: { version: string },
	state: {
		readyToInstall: boolean;
		downloadProgress: number | null;
		downloading: boolean;
		verificationFailure: UpdateVerificationFailure | null;
		downloadFailure: { version: string; error: string } | null;
	}
): string {
	const { readyToInstall, downloadProgress, downloading, verificationFailure, downloadFailure } =
		state;
	if (verificationFailure) {
		return `Couldn't verify Vayu ${verificationFailure.version}. ${verificationFailure.reason}`;
	}
	if (downloadFailure) {
		return `Couldn't download Vayu ${downloadFailure.version} - ${downloadFailure.error}`;
	}
	if (readyToInstall) return `Vayu ${update.version} is ready to install.`;
	if (downloadProgress === null) {
		// A retried download that has not reported a tick: no figure to print yet.
		return downloading
			? `Downloading Vayu ${update.version}…`
			: `Vayu ${update.version} is available.`;
	}
	const percent = Math.round(downloadProgress * 100);
	// The bytes are in, and `verified` waits on the seconds-long attestation check: a bar at 100%
	// reads as a hang.
	if (percent >= 100) return `Verifying Vayu ${update.version}…`;
	return `Downloading Vayu ${update.version}… ${percent}%`;
}

/**
 * Slim banner for a newer Vayu release:
 *
 *   - silent platforms (Windows, Linux AppImage): a progress bar while the update downloads,
 *     "Verifying" while the installer's build-provenance attestation is checked, then
 *     restart-to-install. When the attestation fails (#2372) it says why and offers the release
 *     page; nothing installs.
 *   - macOS (ad-hoc signed): copy the one-line installer command, and quit so it can replace the
 *     app.
 *   - other notify platforms (.deb): link to the release page.
 */
function UpdateBanner() {
	const {
		update,
		readyToInstall,
		downloadProgress,
		downloading,
		verificationFailure,
		downloadFailure,
		dismiss,
		restartToInstall,
		openReleasePage,
		quitForUpdate,
	} = useAppUpdate();
	const { copy, copied } = useCopy({ feedback: "icon" });

	if (!update) return null;

	const message = bannerMessage(update, {
		readyToInstall,
		downloadProgress,
		downloading,
		verificationFailure,
		downloadFailure,
	});

	// The result is the Settings card's to show; the banner follows the download state the check
	// moves.
	const retryDownload = () => {
		void window.electronAPI?.checkForUpdates();
	};

	const copyInstallCommand = async () => {
		if (!update.installCommand) return;
		await copy(update.installCommand, "Install command");
	};

	return (
		// One line at every density (#1670): `h-banner` (#1679), with the progress bar as a thin
		// strip along the bottom edge, absolutely positioned so it adds no height.
		<div className="enter-fade relative flex h-banner items-center gap-3 border-b border-border bg-secondary/60 px-4 text-sm">
			<ArrowUpCircle className="size-icon shrink-0 text-primary" />
			{/*
			 * `title` carries the whole line: the reason is what the user needs, and `truncate`
			 * clips it on a narrow window.
			 */}
			<span className="flex-1 truncate text-secondary-foreground" title={message}>
				{message}
			</span>

			{verificationFailure ? (
				<Button size="sm" variant="secondary" onClick={openReleasePage}>
					<ExternalLink className="size-icon" />
					View release
				</Button>
			) : downloadFailure ? (
				<Button size="sm" variant="secondary" onClick={retryDownload}>
					<RefreshCw className="size-icon" />
					Retry
				</Button>
			) : readyToInstall ? (
				<Button size="sm" onClick={restartToInstall}>
					<RotateCw className="size-icon" />
					Restart &amp; install
				</Button>
			) : downloading ? null : update.installCommand ? (
				<>
					<Button size="sm" variant="secondary" onClick={copyInstallCommand}>
						<IconSwap
							state={copied ? "copied" : "copy"}
							icons={{
								copy: <Copy className="size-icon" />,
								copied: <Check className="size-icon" />,
							}}
						/>
						<LabelSwap
							label={copied ? "Copied" : "Copy install command"}
							states={["Copied", "Copy install command"]}
						/>
					</Button>
					{/*
					 * The installer cannot replace a bundle with running processes, so it quits
					 * Vayu itself, but from a terminal that is an Apple Event macOS gates behind an
					 * Automation consent prompt. Quitting here needs no permission and runs the
					 * normal shutdown, so the paste lands on a closed app.
					 */}
					<Button size="sm" variant="ghost" onClick={quitForUpdate}>
						<Power className="size-icon" />
						Quit to update
					</Button>
				</>
			) : (
				<Button size="sm" variant="secondary" onClick={openReleasePage}>
					<ExternalLink className="size-icon" />
					View release
				</Button>
			)}

			{/* `size="icon"` gives the `target` floor (#1679), so no size override. */}
			<TooltipIconButton
				onClick={dismiss}
				label="Dismiss update notification"
				tooltip="Dismiss"
				icon={<X className="size-icon-sm" />}
			/>

			{downloading ? (
				<Progress
					value={downloadProgress}
					label={`Downloading Vayu ${update.version}`}
					className="absolute inset-x-0 bottom-0 h-0.5 rounded-none"
				/>
			) : null}
		</div>
	);
}

export default UpdateBanner;
