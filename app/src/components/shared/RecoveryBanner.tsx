/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEngineStore, useRecoveryNoticeStore } from "@/stores";
import type { EngineRecovery } from "@/types/domain";

const LOSS =
	"Collections, requests, environments, saved examples and run history from before are gone.";

/**
 * The notice, per outcome.
 *
 * A `Record` over the union rather than a chain of comparisons: an outcome the
 * engine adds without copy for it is then a type error here, instead of falling
 * silently into whichever branch happens to be last - which is exactly how the
 * two outcomes #984 added would have been announced as deletions.
 */
const HEADLINE: Record<EngineRecovery["outcome"], string> = {
	restored_from_backup: "Your Vayu data was restored from a backup",
	deleted_corrupt: "Your Vayu data was reset",
	backup_also_corrupt: "Your Vayu data was reset",
	started_fresh_quarantined: "Your Vayu data was reset",
};

const DETAIL: Record<EngineRecovery["outcome"], string> = {
	restored_from_backup:
		"The database could not be opened, so the last backup beside it was restored. Anything saved after that backup was taken is gone.",
	deleted_corrupt: `The database could not be opened and no usable backup was found, so it was deleted and a new empty one was created. ${LOSS}`,
	backup_also_corrupt: `The database could not be opened, and the backup beside it could not be opened either - so it was left untouched and a new empty database was created. ${LOSS}`,
	started_fresh_quarantined: `The database could not be opened and no usable backup was found, so a new empty one was created. ${LOSS}`,
};

/**
 * The one place the user is told the engine restored or deleted their database
 * (issue #922).
 *
 * A database that fails validation at startup and cannot be restored from its
 * `.bak` backup is replaced by an empty one, so the daemon starts instead of
 * crash-looping. That is the right call, and until this banner the whole record
 * of it was two lines in the engine log: every collection, request,
 * environment, example, spec and run was gone and the app came up looking like
 * a fresh install.
 *
 * A banner rather than a toast, and this banner rather than the connection
 * tooltip in the Dock: the fact is permanent, the user cannot act on it later
 * if they miss it, and it names a path they may want to copy. It sits beside
 * `UpdateBanner` and shares its shape for that reason.
 *
 * Since issue #984 the engine keeps the unreadable file rather than deleting
 * it, and this is the only place its path and the `sqlite3 ... .recover` that
 * reads it are shown - so the salvage route exists exactly as far as this
 * component renders it.
 *
 * Shown once *ever* per event, not once per session - `recovery-notice-store`
 * remembers the timestamp that was dismissed, because the engine keeps
 * reporting the record for as long as its marker file stands.
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
			className="flex items-center gap-3 border-b border-border bg-secondary/60 px-4 py-2 text-sm"
		>
			<AlertTriangle
				className={
					deleted
						? "size-4 shrink-0 text-destructive-text"
						: "size-4 shrink-0 text-warning-text"
				}
				aria-hidden="true"
			/>
			<span className="flex-1 min-w-0 text-secondary-foreground">
				<span className="font-semibold">{HEADLINE[recovery.outcome]}</span>{" "}
				{DETAIL[recovery.outcome]}{" "}
				{/* The path, not a prose description of it: it is what the user
				    needs to look in, and it is the one part of this they can act
				    on - by restoring their own copy of the file. */}
				<span className="break-all font-mono text-xs text-muted-foreground">
					{recovery.databasePath}
				</span>
				{recovery.quarantinedPath && (
					/* The unreadable file is kept rather than deleted (issue
					   #984), and this is the only place the user is told so -
					   with the command, because a path alone does not tell
					   someone that most of their rows are probably still in it. */
					<>
						{" "}
						The unreadable database was kept, and{" "}
						<span className="break-all font-mono text-xs text-muted-foreground">
							sqlite3 {recovery.quarantinedPath} .recover
						</span>{" "}
						can often extract most of it.
					</>
				)}
			</span>
			<Button
				size="icon"
				variant="ghost"
				className="size-7 shrink-0"
				onClick={() => acknowledge(recovery.at)}
				aria-label="Dismiss data recovery notice"
			>
				<X className="size-4" />
			</Button>
		</div>
	);
}

export default RecoveryBanner;
