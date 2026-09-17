/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState } from "react";
import { ArrowUpCircle, Check, Copy, ExternalLink, Power, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LabelSwap } from "@/components/ui/label-swap";
import { Progress } from "@/components/ui/progress";
import { useAppUpdate } from "@/hooks/useAppUpdate";

/**
 * Slim banner that appears when a newer Vayu release is available.
 *
 *   - silent platforms (Windows, Linux AppImage): shows a progress bar while
 *     the update downloads in the background, then a restart-to-install.
 *   - macOS (ad-hoc signed): offer to copy the one-line installer command, and
 *     to quit so the command can replace the app it is pasted for.
 *   - other notify platforms (.deb): link to the release page.
 */
function UpdateBanner() {
	const {
		update,
		readyToInstall,
		downloadProgress,
		dismiss,
		restartToInstall,
		openReleasePage,
		quitForUpdate,
	} = useAppUpdate();
	const [copied, setCopied] = useState(false);

	if (!update) return null;

	const downloading = !readyToInstall && downloadProgress !== null;

	const copyInstallCommand = async () => {
		if (!update.installCommand) return;
		await navigator.clipboard.writeText(update.installCommand);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	return (
		// One line at every density (issue #1670): `h-banner` (issue #1679 -
		// was `h-[var(--tabstrip-height)]`, the tab strip's own band and 4px
		// short of a notification bar's floor) rather than stacking a second
		// row for the download progress bar, which used to make this banner
		// two lines tall while downloading. The bar still shows - as a thin
		// strip along the bottom edge, absolutely positioned so it adds no
		// height of its own.
		<div className="enter-fade relative flex h-banner items-center gap-3 border-b border-border bg-secondary/60 px-4 text-sm">
			<ArrowUpCircle className="size-icon shrink-0 text-primary" />
			<span className="flex-1 truncate text-secondary-foreground">
				{readyToInstall
					? `Vayu ${update.version} is ready to install.`
					: downloading
						? `Downloading Vayu ${update.version}… ${Math.round(downloadProgress * 100)}%`
						: `Vayu ${update.version} is available.`}
			</span>

			{readyToInstall ? (
				<Button size="sm" onClick={restartToInstall}>
					<RotateCw className="size-icon" />
					Restart &amp; install
				</Button>
			) : downloading ? null : update.installCommand ? (
				<>
					<Button size="sm" variant="secondary" onClick={copyInstallCommand}>
						{copied ? <Check className="size-icon" /> : <Copy className="size-icon" />}
						<LabelSwap
							label={copied ? "Copied" : "Copy install command"}
							states={["Copied", "Copy install command"]}
						/>
					</Button>
					{/*
					 * The installer cannot replace a bundle whose processes are
					 * still running, so it quits Vayu itself - but from a
					 * terminal that is an Apple Event, which macOS gates behind
					 * an Automation consent prompt. Quitting from here needs no
					 * permission and runs the normal shutdown, so the paste
					 * lands on an app that is already closed.
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

			{/* `size="icon"` alone now gives the `target` floor (issue #1679) -
			    no `size-7` override needed, the way one was before it existed. */}
			<Button
				size="icon"
				variant="ghost"
				onClick={dismiss}
				aria-label="Dismiss update notification"
			>
				<X className="size-icon-sm" />
			</Button>

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
