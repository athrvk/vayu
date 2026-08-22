/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEngineStore, useRecoveryNoticeStore } from "@/stores";

/**
 * The one place the user is told the engine restored or deleted their database
 * (issue #922).
 *
 * A database that fails validation at startup and cannot be restored from its
 * `.bak` backup is **deleted**, so the daemon starts instead of crash-looping.
 * That is the right call, and until this banner the whole record of it was two
 * lines in the engine log: every collection, request, environment, example,
 * spec and run was gone and the app came up looking like a fresh install.
 *
 * A banner rather than a toast, and this banner rather than the connection
 * tooltip in the Dock: the fact is permanent, the user cannot act on it later
 * if they miss it, and it names a path they may want to copy. It sits beside
 * `UpdateBanner` and shares its shape for that reason.
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

	const deleted = recovery.outcome === "deleted_corrupt";

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
				<span className="font-semibold">
					{deleted
						? "Your Vayu data was reset"
						: "Your Vayu data was restored from a backup"}
				</span>{" "}
				{deleted
					? "The database could not be opened and no usable backup was found, so it was deleted and a new empty one was created. Collections, requests, environments, saved examples and run history from before are gone."
					: "The database could not be opened, so the last backup beside it was restored. Anything saved after that backup was taken is gone."}{" "}
				{/* The path, not a prose description of it: it is what the user
				    needs to look in, and it is the one part of this they can act
				    on - by restoring their own copy of the file. */}
				<span className="break-all font-mono text-xs text-muted-foreground">
					{recovery.databasePath}
				</span>
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
