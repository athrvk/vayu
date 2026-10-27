/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import {
	Bookmark,
	Check,
	Cloud,
	Copy,
	Folder,
	FileJson,
	Loader2,
	RotateCcw,
	Trash2,
	type LucideIcon,
} from "lucide-react";

import { Button, IconSwap, ICON_MOTION } from "@/components/ui";
import { TruncatedText } from "@/components/shared";
import { TimeValue } from "@/components/shared/TimeValue";
import { useCopy } from "@/hooks/useCopy";
import { trashReference } from "@/lib/agent-reference";
import { pluralize } from "@/modules/dashboard/utils/format";
import type { TrashEntry } from "@/types";

interface TrashItemProps {
	entry: TrashEntry;
	onRestore: (entry: TrashEntry) => void;
	onPurge: (entry: TrashEntry) => void;
	isRestoring: boolean;
	isPurging: boolean;
}

/**
 * How each kind reads on a row. A `Record` over the union, not a ternary: a kind
 * the engine adds fails to compile here until it has a glyph and a word, rather
 * than rendering as whichever kind the ternary's last branch named. The
 * environment's glyph is the one the Variables view draws for an environment,
 * and the example's is the bookmark family "Save as example" uses.
 */
const KIND_DISPLAY: Record<TrashEntry["kind"], { icon: LucideIcon; label: string }> = {
	collection: { icon: Folder, label: "Collection" },
	request: { icon: FileJson, label: "Request" },
	environment: { icon: Cloud, label: "Environment" },
	example: { icon: Bookmark, label: "Example" },
};

/**
 * What a delete took with it, as a phrase - "with 3 requests", "with 2
 * collections, 11 requests", "with 12 variables" - or nothing at all when the
 * entry stood alone.
 *
 * The counts are the engine's, over the cohort that single delete stamped (or,
 * for an environment, the variables on its own row), and they are the one thing
 * a trash row says that the tree could never have shown: a collection in the
 * trash looks exactly like an empty one otherwise, and restoring it is a
 * different-sized act depending on the answer.
 */
function contentsSummary(entry: TrashEntry): string | null {
	const parts: string[] = [];
	if (entry.collections > 0) {
		parts.push(`${entry.collections} ${pluralize(entry.collections, "collection")}`);
	}
	if (entry.requests > 0) {
		parts.push(`${entry.requests} ${pluralize(entry.requests, "request")}`);
	}
	if (entry.variables) {
		parts.push(`${entry.variables} ${pluralize(entry.variables, "variable")}`);
	}
	return parts.length > 0 ? `with ${parts.join(", ")}` : null;
}

/**
 * One deleted root, with the two things that can happen to it and a copy of
 * its reference for an agent.
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
	const { icon: KindIcon, label: kindLabel } = KIND_DISPLAY[entry.kind];
	const contents = contentsSummary(entry);
	const busy = isRestoring || isPurging;
	const { copy, copied } = useCopy({ feedback: "icon" });

	return (
		// `surface-card` + `border-rule` rather than a border token: `--border` on
		// `--card` is the same colour in dark, so the row would have no edge. See
		// RunItem, which carries the same pair for the same reason.
		// No `group`: nothing here reveals on hover, so a group class would be a
		// hook with nothing hanging off it.
		<div
			// Where a purge hands focus on to (#1234). `tabIndex={-1}` makes the row
			// a target for `.focus()` without adding a tab stop in front of the
			// buttons, and it holds even while they are disabled by the purge in
			// flight - which is exactly when focus needs somewhere to be.
			data-trash-id={entry.id}
			tabIndex={-1}
			// `focus-row`, not the baseline ring: this row is a composite the
			// baseline would leave unmarked, since it is written
			// `[tabindex]:not([tabindex="-1"])`.
			className="focus-row surface-card border border-rule rounded-md overflow-hidden w-full"
		>
			<div className="flex items-center gap-2 px-3 py-2 min-w-0">
				<KindIcon className="size-icon shrink-0 text-muted-foreground" aria-hidden="true" />

				<div className="flex-1 min-w-0">
					<TruncatedText className="text-sm text-foreground">{entry.name}</TruncatedText>
					{/*
					 * The kind is written out, not left to the icon. The glyph
					 * is `aria-hidden` (it is decoration, per the design
					 * system), so with the icon alone a screen reader gets a
					 * name and a date and no way to tell a deleted folder from
					 * a deleted request - and a sighted reader has to already
					 * know which shape means which.
					 */}
					<p className="text-xs text-muted-foreground">
						{kindLabel} · Deleted <TimeValue value={entry.deletedAt} style="relative" />
						{contents ? `, ${contents}` : ""}
					</p>
				</div>

				<div className="flex items-center gap-1 shrink-0">
					<Button
						variant="rowAction"
						size="icon"
						onClick={() => void copy(trashReference(entry), "Reference")}
						aria-label={`Copy ${entry.name} for agent`}
						title="Copy for agent"
					>
						<IconSwap
							state={copied ? "copied" : "copy"}
							icons={{
								copy: <Copy className="size-icon-sm" />,
								copied: <Check className="size-icon-sm text-status-success-text" />,
							}}
						/>
					</Button>
					<Button
						variant="rowAction"
						size="icon"
						onClick={() => onRestore(entry)}
						disabled={busy}
						aria-label={`Restore ${entry.name}`}
						title="Restore"
					>
						{isRestoring ? (
							<Loader2 className="size-icon-sm animate-spin" />
						) : (
							<RotateCcw
								className="size-icon-sm"
								data-icon-motion={ICON_MOTION.spinBack}
							/>
						)}
					</Button>
					<Button
						variant="rowActionDestructive"
						size="icon"
						onClick={() => onPurge(entry)}
						disabled={busy}
						aria-label={`Delete ${entry.name} forever`}
						title="Delete forever"
					>
						{isPurging ? (
							<Loader2 className="size-icon-sm animate-spin" />
						) : (
							<Trash2 className="size-icon-sm" />
						)}
					</Button>
				</div>
			</div>
		</div>
	);
}
