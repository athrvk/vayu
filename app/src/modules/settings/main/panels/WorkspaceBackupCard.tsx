/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * WorkspaceBackupCard
 *
 * One button that asks the engine for a snapshot of the workspace, and the path
 * it wrote (issue #987).
 *
 * Everything a person has built in Vayu - collections, environments, stored
 * credentials, run history - lives in one SQLite file, and until this there was
 * no copy of it the user controlled. The `.bak` the engine keeps is not one: it
 * is overwritten on every clean start and exists so a corrupt file has
 * something to restore from, not so someone can go back to last week.
 *
 * It sits in General beside Data management and Storage paths, because this is
 * engine-held state the user did not type - the same reason CookiesCard is
 * there - and because the path this prints only means something next to the
 * Data directory printed below it.
 *
 * **The path is shown, not just toasted.** Restoring is a file copy the user
 * performs with the engine stopped (there is deliberately no restore button),
 * so the one thing they need afterwards is where the file went - and a toast
 * that has faded cannot tell them.
 */

import { useState } from "react";
import { HardDriveDownload, Loader2 } from "lucide-react";

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { apiService } from "@/services";
import { ApiError } from "@/services/http-client";
import { useToastStore } from "@/stores";
import type { WorkspaceBackupResult } from "@/types";
import { appSetting } from "../app-settings";

// Headings come from the catalogue so search cannot offer a name this panel
// does not print - see `app-settings.ts`.
const WORKSPACE_BACKUP = appSetting("workspace-backup");

/** A snapshot's size, in the units a person reads a file size in. */
function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"] as const;
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

export function WorkspaceBackupCard() {
	const showToast = useToastStore((s) => s.showToast);
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<WorkspaceBackupResult | null>(null);
	const [failure, setFailure] = useState<string | null>(null);

	const backUp = async () => {
		setRunning(true);
		setFailure(null);
		try {
			const snapshot = await apiService.backupWorkspace();
			setResult(snapshot);
			showToast("Workspace backed up", "success");
		} catch (error) {
			// A 409 is not a failure of the backup - the user's own earlier
			// request is still writing the file - and saying "could not back up"
			// would send them looking for a problem that is not there.
			const message =
				error instanceof ApiError && error.statusCode === 409
					? "A backup is already running - it will finish on its own."
					: error instanceof Error
						? error.message
						: "The engine did not answer";
			setFailure(message);
			showToast("Could not back up the workspace", "error");
		} finally {
			setRunning(false);
		}
	};

	return (
		<Card data-setting-anchor={WORKSPACE_BACKUP.anchor}>
			<CardHeader className="pb-3">
				<div className="flex items-center gap-2">
					<HardDriveDownload className="w-5 h-5 text-muted-foreground" />
					<CardTitle className="text-base">{WORKSPACE_BACKUP.label}</CardTitle>
				</div>
				<CardDescription>
					Writes a complete, compacted copy of the workspace - collections, environments,
					credentials and run history - into a backups folder beside the database. Safe to
					run while Vayu is working; copying the database file by hand is not.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				<div className="flex items-center justify-between gap-4">
					<p className="text-sm text-muted-foreground">
						How many snapshots are kept is set by Max Backups Retained under Engine &gt;
						Data &amp; retention.
					</p>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={running}
						onClick={() => void backUp()}
					>
						{running ? (
							<Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
						) : (
							<HardDriveDownload className="w-4 h-4 mr-1.5" />
						)}
						Back up now
					</Button>
				</div>

				{failure && <p className="text-sm text-status-error-text">{failure}</p>}

				{result && (
					<div className="surface-sunken rounded-md border border-rule p-3 space-y-1">
						<p className="text-xs text-muted-foreground">
							Saved {formatSize(result.sizeBytes)} at{" "}
							{new Date(result.createdAt).toLocaleString()}
							{result.pruned > 0 &&
								` - removed ${result.pruned} older snapshot${result.pruned === 1 ? "" : "s"}`}
						</p>
						<p className="text-xs font-mono break-all text-foreground">{result.path}</p>
						{/* Restoring is a manual copy with the engine stopped, so the
						    procedure is where the file name is, not in a doc the user
						    has to know exists. */}
						<p className="text-xs text-muted-foreground">
							To restore: quit Vayu, copy this file over the database shown under
							Storage paths, delete its <code>-wal</code> and <code>-shm</code>{" "}
							neighbours, and start Vayu again.
						</p>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
