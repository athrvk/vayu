/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { AlertTriangle, X } from "lucide-react";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { useEngineStore, useRecoveryNoticeStore } from "@/stores";
import type { EngineRecovery } from "@/types/domain";

const LOSS =
	"Collections, requests, environments, saved examples and run history from before are gone.";

/**
 * The notice per outcome, a `Record` over the union rather than comparisons, so an outcome the
 * engine adds without copy is a type error instead of falling into the last branch (as #984's two
 * would have been announced as deletions).
 */
const HEADLINE: Record<EngineRecovery["outcome"], string> = {
	restored_from_backup: "Your Vayu data was restored from a backup",
	deleted_corrupt: "Your Vayu data was reset",
	backup_also_corrupt: "Your Vayu data was reset",
	started_fresh_quarantined: "Your Vayu data was reset",
};

const DETAIL: Record<EngineRecovery["outcome"], string> = {
	restored_from_backup:
		"The database couldn't be opened, so the last backup beside it was restored. Anything saved after that backup was taken is gone.",
	deleted_corrupt: `The database couldn't be opened and no usable backup was found, so it was deleted and a new empty one was created. ${LOSS}`,
	backup_also_corrupt: `The database couldn't be opened, and the backup beside it couldn't be opened either - so it was left untouched and a new empty database was created. ${LOSS}`,
	started_fresh_quarantined: `The database couldn't be opened and no usable backup was found, so a new empty one was created. ${LOSS}`,
};

/**
 * The one place the user is told the engine restored or deleted their database (#922). A database
 * failing startup validation that cannot be restored from its `.bak` is replaced by an empty one,
 * so the daemon starts instead of crash-looping; without this banner the record was two log lines,
 * every collection, request, environment, example, spec and run gone and the app looking freshly
 * installed. A banner, not a toast or the Dock's connection tooltip: the fact is permanent, missing
 * it cannot be undone, and it names a path worth copying; it shares `UpdateBanner`'s shape for
 * that. The engine keeps the unreadable file (#984), and this is the only place its path, the way
 * to put it back (#2420) and the `sqlite3 ... .recover` that reads it are shown: the salvage route
 * exists as far as this renders it. Shown once *ever* per event, not per session:
 * `recovery-notice-store` remembers the dismissed timestamp, as the engine reports the record while
 * its marker file stands.
 */
function RecoveryBanner() {
	const recovery = useEngineStore((s) => s.recovery);
	const acknowledgedAt = useRecoveryNoticeStore((s) => s.acknowledgedAt);
	const acknowledge = useRecoveryNoticeStore((s) => s.acknowledge);

	if (!recovery || acknowledgedAt === recovery.at) return null;

	const restored = recovery.outcome === "restored_from_backup";
	const deleted = !restored;

	return (
		<div
			role="status"
			// `min-h-banner` (#1679, a 36px floor), not `UpdateBanner`'s fixed `h-banner`: this
			// text wraps (the outcome, a path, sometimes a command), where `UpdateBanner` is one
			// line; a floor lets it grow and never sit under 36px.
			className="enter-fade flex min-h-banner items-center gap-3 border-b border-border bg-secondary/60 px-4 py-2 text-sm"
		>
			<AlertTriangle
				className={
					deleted
						? "size-icon shrink-0 text-destructive-text"
						: "size-icon shrink-0 text-warning-text"
				}
				aria-hidden="true"
			/>
			<span className="flex-1 min-w-0 text-secondary-foreground">
				<span className="font-semibold">{HEADLINE[recovery.outcome]}</span>{" "}
				{DETAIL[recovery.outcome]}{" "}
				{/*
				 * The path, not prose about it: it is where to look, and the part the user can act
				 * on by restoring their own copy.
				 */}
				<span className="break-all font-mono text-xs text-muted-foreground">
					{recovery.databasePath}
				</span>
				{recovery.quarantinedPath && (
					/*
					 * The previous file is kept (#984), and this is the only place the user learns
					 * where and how to restore it (#2420): the engine judged it, and judgements can
					 * be wrong. The sidecars travel with it, as its -wal holds writes the main file
					 * has not taken and a stale one beside the copy would be replayed onto it. The
					 * command is for a truly damaged file, as a path alone does not say most rows
					 * are probably still in it.
					 */
					<>
						{" "}
						The previous file was kept at{" "}
						<span className="break-all font-mono text-xs text-muted-foreground">
							{recovery.quarantinedPath}
						</span>
						. If it was healthy after all, quit Vayu and copy it back over the database
						file above to undo this, along with its -wal and -shm files, and delete any
						-wal and -shm beside the database that the set does not have. If it is
						damaged,{" "}
						<span className="break-all font-mono text-xs text-muted-foreground">
							sqlite3 {recovery.quarantinedPath} .recover
						</span>{" "}
						can often extract most of it.
					</>
				)}
			</span>
			{/* `size="icon"` gives the `target` floor (#1679), so no size override. */}
			<TooltipIconButton
				className="shrink-0"
				onClick={() => acknowledge(recovery.at)}
				label="Dismiss data recovery notice"
				tooltip="Dismiss"
				icon={<X className="size-icon-sm" />}
			/>
		</div>
	);
}

export default RecoveryBanner;
