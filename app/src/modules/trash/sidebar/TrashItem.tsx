/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { Folder, FileJson, Loader2, RotateCcw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui";
import { TruncatedText } from "@/components/shared";
import { formatRelativeTime } from "@/utils";
import type { TrashEntry } from "@/types";

interface TrashItemProps {
	entry: TrashEntry;
	onRestore: (entry: TrashEntry) => void;
	onPurge: (entry: TrashEntry) => void;
	isRestoring: boolean;
	isPurging: boolean;
}

/**
 * What a delete took with it, as a phrase - "and 3 requests", "and 2 folders,
 * 11 requests" - or nothing at all when the entry stood alone.
 *
 * The counts are the engine's, over the cohort that single delete stamped, and
 * they are the one thing a trash row says that the tree could never have shown:
 * a folder in the trash looks exactly like an empty one otherwise, and
 * restoring it is a different-sized act depending on the answer.
 */
function cascadeSummary(entry: TrashEntry): string | null {
	const parts: string[] = [];
	if (entry.collections > 0) {
		parts.push(`${entry.collections} ${entry.collections === 1 ? "folder" : "folders"}`);
	}
	if (entry.requests > 0) {
		parts.push(`${entry.requests} ${entry.requests === 1 ? "request" : "requests"}`);
	}
	return parts.length > 0 ? `with ${parts.join(", ")}` : null;
}

/**
 * One deleted root, with the two things that can happen to it.
 *
 * **The actions are always visible, and that is deliberate.** The design
 * system hover-reveals row actions because a drawer row has a primary action of
 * its own - open the request, select the run - that the buttons must not
 * compete with. A trash row has none: it opens nothing, and Restore and Delete
 * forever are the entire reason it is on screen. Hiding them until the pointer
 * arrives would hide the whole surface's purpose, and leave a list of names
 * that appears inert.
 */
export default function TrashItem({
	entry,
	onRestore,
	onPurge,
	isRestoring,
	isPurging,
}: TrashItemProps) {
	const KindIcon = entry.kind === "collection" ? Folder : FileJson;
	const cascade = cascadeSummary(entry);
	const busy = isRestoring || isPurging;

	return (
		// `surface-card` + `border-rule` rather than a border token: `--border` on
		// `--card` is the same colour in dark, so the row would have no edge. See
		// RunItem, which carries the same pair for the same reason.
		<div className="group relative surface-card border border-rule rounded-md overflow-hidden w-full">
			<div className="flex items-center gap-2 px-3 py-2 min-w-0">
				<KindIcon className="w-4 h-4 shrink-0 text-muted-foreground" aria-hidden="true" />

				<div className="flex-1 min-w-0">
					<TruncatedText className="text-sm text-foreground">{entry.name}</TruncatedText>
					<p className="text-xs text-muted-foreground">
						Deleted {formatRelativeTime(new Date(entry.deletedAt).toISOString())}
						{cascade ? `, ${cascade}` : ""}
					</p>
				</div>

				<div className="flex items-center gap-1 shrink-0">
					<Button
						variant="rowAction"
						size="icon"
						onClick={() => onRestore(entry)}
						disabled={busy}
						aria-label={`Restore ${entry.name}`}
						title="Put this back where it came from"
						className="h-6 w-6"
					>
						{isRestoring ? (
							<Loader2 className="w-3 h-3 animate-spin" />
						) : (
							<RotateCcw className="w-3 h-3" />
						)}
					</Button>
					<Button
						variant="rowActionDestructive"
						size="icon"
						onClick={() => onPurge(entry)}
						disabled={busy}
						aria-label={`Delete ${entry.name} forever`}
						title="Delete forever"
						className="h-6 w-6"
					>
						{isPurging ? (
							<Loader2 className="w-3 h-3 animate-spin" />
						) : (
							<Trash2 className="w-3 h-3" />
						)}
					</Button>
				</div>
			</div>
		</div>
	);
}
