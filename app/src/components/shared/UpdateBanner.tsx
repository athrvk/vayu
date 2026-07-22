/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState } from "react";
import { ArrowUpCircle, Check, Copy, ExternalLink, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppUpdate } from "@/hooks/useAppUpdate";

/**
 * Slim banner that appears when a newer Vayu release is available.
 *
 *   - silent platforms (Windows, Linux AppImage): the update is already
 *     downloaded - offer a restart-to-install.
 *   - macOS (ad-hoc signed): offer to copy the one-line installer command.
 *   - other notify platforms (.deb): link to the release page.
 */
function UpdateBanner() {
	const { update, readyToInstall, dismiss, restartToInstall, openReleasePage } = useAppUpdate();
	const [copied, setCopied] = useState(false);

	if (!update) return null;

	const copyInstallCommand = async () => {
		if (!update.installCommand) return;
		await navigator.clipboard.writeText(update.installCommand);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	return (
		<div className="flex items-center gap-3 border-b border-border bg-secondary/60 px-4 py-2 text-sm">
			<ArrowUpCircle className="size-4 shrink-0 text-primary" />
			<span className="flex-1 truncate text-secondary-foreground">
				{readyToInstall
					? `Vayu ${update.version} is ready to install.`
					: `Vayu ${update.version} is available.`}
			</span>

			{readyToInstall ? (
				<Button size="sm" onClick={restartToInstall}>
					<RotateCw className="size-4" />
					Restart &amp; install
				</Button>
			) : update.installCommand ? (
				<Button size="sm" variant="secondary" onClick={copyInstallCommand}>
					{copied ? <Check className="size-4" /> : <Copy className="size-4" />}
					{copied ? "Copied" : "Copy install command"}
				</Button>
			) : (
				<Button size="sm" variant="secondary" onClick={openReleasePage}>
					<ExternalLink className="size-4" />
					View release
				</Button>
			)}

			<Button
				size="icon"
				variant="ghost"
				className="size-7"
				onClick={dismiss}
				aria-label="Dismiss update notification"
			>
				<X className="size-4" />
			</Button>
		</div>
	);
}

export default UpdateBanner;
