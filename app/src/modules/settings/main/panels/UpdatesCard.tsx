/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * UpdatesCard — the current version, and a way to ask for a newer one.
 *
 * Vayu already checked for updates on a timer and announced the result through
 * a banner, but there was no way to *ask*. The only manual check lived in the
 * native menu, where it answers with a modal `dialog.showMessageBox` — fine for
 * a menu item that has no UI of its own, wrong for a settings panel that does.
 * So this renders the same outcome in place: the result appears under the
 * button and stays there.
 *
 * The four outcomes are all worth distinguishing:
 *
 *   - up to date  — the reassurance the user clicked for.
 *   - available   — with the release notes link, and (macOS) the ad-hoc-signed
 *                   installer command, because that platform updates
 *                   out-of-band.
 *   - unavailable — a development or unpackaged build has no release feed. Not
 *                   an error; saying "check failed" here would be a lie.
 *   - error       — the network, or the feed. Shows the reason.
 */

import { useState } from "react";
import { ArrowUpCircle, Check, Copy, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import type { UpdateCheckResult } from "@/types/electron";

const APP_VERSION = typeof __VAYU_VERSION__ !== "undefined" ? __VAYU_VERSION__ : "0.0.0";

export function UpdatesCard() {
	const [checking, setChecking] = useState(false);
	const [result, setResult] = useState<UpdateCheckResult | null>(null);
	const [copied, setCopied] = useState(false);

	const api = window.electronAPI;

	const check = async () => {
		if (!api) return;
		setChecking(true);
		try {
			setResult(await api.checkForUpdates());
		} catch (err) {
			setResult({
				status: "error",
				message: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setChecking(false);
		}
	};

	const copyInstallCommand = async (command: string) => {
		await navigator.clipboard.writeText(command);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	/**
	 * Every outcome renders in the same slot under the button, so a second check
	 * replaces the first answer rather than stacking beneath it.
	 */
	const renderOutcome = () => {
		if (!api) {
			return (
				<p className="text-sm text-muted-foreground">
					Update checks are available in the desktop app.
				</p>
			);
		}
		// Checked before `result`, so a second check replaces the previous
		// answer the moment it starts. Reading the old one the other way round
		// leaves "You're up to date" on screen while a new check is running,
		// which looks like the answer to the click that just happened.
		if (checking) return <p className="text-sm text-muted-foreground">Checking…</p>;
		if (!result) return null;

		switch (result.status) {
			case "up-to-date":
				return (
					<p className="text-sm text-success-text">
						You&apos;re up to date — {result.version} is the latest version.
					</p>
				);
			case "unavailable":
				return <p className="text-sm text-muted-foreground">{result.detail}</p>;
			case "error":
				return (
					<p className="text-sm text-destructive-text">
						Couldn&apos;t check for updates. {result.message}
					</p>
				);
			case "available": {
				// Bound here so the optional survives narrowing into the handler.
				const { version, strategy, releaseUrl, installCommand } = result;
				return (
					<div className="space-y-2">
						<p className="text-sm text-foreground">
							Vayu <span className="font-mono">{version}</span> is available.
							{strategy === "silent" &&
								" It downloads in the background; restart to install it."}
						</p>
						<div className="flex flex-wrap items-center gap-2">
							<Button
								variant="outline"
								size="sm"
								onClick={() => void api.openReleasePage(releaseUrl)}
							>
								<ExternalLink className="w-4 h-4 mr-1.5" />
								Release notes
							</Button>
							{installCommand && (
								<Button
									variant="outline"
									size="sm"
									onClick={() => void copyInstallCommand(installCommand)}
								>
									{copied ? (
										<Check className="w-4 h-4 mr-1.5" />
									) : (
										<Copy className="w-4 h-4 mr-1.5" />
									)}
									{copied ? "Copied" : "Copy install command"}
								</Button>
							)}
						</div>
					</div>
				);
			}
		}
	};

	return (
		<Card>
			<CardHeader className="pb-3">
				<div className="flex items-center gap-2">
					<ArrowUpCircle className="w-5 h-5 text-muted-foreground" />
					<CardTitle className="text-base">Updates</CardTitle>
				</div>
				<CardDescription>
					Vayu checks for new releases on its own; this asks right now.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				<div className="flex items-center justify-between gap-4">
					<p className="text-sm text-muted-foreground">
						You&apos;re on Vayu{" "}
						<span className="font-mono text-foreground">{APP_VERSION}</span>.
					</p>
					<Button variant="outline" size="sm" onClick={check} disabled={!api || checking}>
						{checking ? (
							<Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
						) : (
							<RefreshCw className="w-4 h-4 mr-1.5" />
						)}
						Check for updates
					</Button>
				</div>

				{/*
				 * `role="status"` so the outcome is announced: the button is the
				 * only thing that changed visually, and a sighted user reads the
				 * answer that appears beneath it.
				 */}
				<div role="status" aria-live="polite">
					{renderOutcome()}
				</div>
			</CardContent>
		</Card>
	);
}
