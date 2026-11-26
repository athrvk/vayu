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
	KeyRound,
	Loader2,
	RotateCcw,
	Trash2,
	type LucideIcon,
} from "lucide-react";

import { IconSwap, ICON_MOTION, TooltipIconButton } from "@/components/ui";
import { ROW_ACTIONS_REVEAL, TruncatedText } from "@/components/shared";
import { TimeValue } from "@/components/shared/TimeValue";
import { useCopy } from "@/hooks/useCopy";
import { useOverflowTitle } from "@/hooks/useOverflowTitle";
import { formatInstant } from "@/lib/time-value";
import { cn } from "@/lib/utils";
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
 * How each kind reads on a row. A `Record` over the union, not a ternary, so a kind the engine adds
 * fails to compile until it has a glyph and a word. The environment's glyph is the one the
 * Variables view draws for it, the example's the bookmark family "Save as example" uses, the
 * certificate's the one heading its Settings card.
 */
const KIND_DISPLAY: Record<TrashEntry["kind"], { icon: LucideIcon; label: string }> = {
	collection: { icon: Folder, label: "Collection" },
	request: { icon: FileJson, label: "Request" },
	environment: { icon: Cloud, label: "Environment" },
	example: { icon: Bookmark, label: "Example" },
	clientCertificate: { icon: KeyRound, label: "Client certificate" },
};

/**
 * What a purge of this entry destroys, as a phrase ("with 3 requests", "with 2 collections, 11
 * requests", "with 12 variables"), or nothing when the entry stood alone. It is the one thing a
 * trash row says that the tree could not: a collection in the trash otherwise looks exactly like an
 * empty one.
 *
 * A collection reads the engine's **purge** totals, not the cohort counts (#3449): a purge also
 * takes whatever an earlier delete left under the root, so the cohort is a floor, and "Delete
 * forever" is the wrong moment to undercount. An environment's number is the variables on its own
 * row.
 */
function contentsSummary(entry: TrashEntry): string | null {
	const parts: string[] = [];
	if (entry.purgeCollections > 0) {
		parts.push(`${entry.purgeCollections} ${pluralize(entry.purgeCollections, "collection")}`);
	}
	if (entry.purgeRequests > 0) {
		parts.push(`${entry.purgeRequests} ${pluralize(entry.purgeRequests, "request")}`);
	}
	if (entry.variables) {
		parts.push(`${entry.variables} ${pluralize(entry.variables, "variable")}`);
	}
	return parts.length > 0 ? `with ${parts.join(", ")}` : null;
}

/**
 * One deleted root: restore, delete forever, and a copy of its reference for an agent.
 *
 * **The actions take no width until the row is hovered or focused** (#3495): three visible buttons
 * left the name about 105px of a 260px drawer. They stay in the DOM and keyboard-reachable
 * (`ROW_ACTIONS_REVEAL`), and a device with no hover keeps them showing, since Restore and Delete
 * forever are the reason a trash row is on screen.
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
	// One line, with the full sentence on hover only while it is cut. The time is
	// spelled out here for that title; the visible one is still a `TimeValue`.
	const metaTitle = [
		`${kindLabel}${entry.parentName ? ` · from ${entry.parentName}` : ""}`,
		` · Deleted ${formatInstant(entry.deletedAt, "relative")}`,
		contents ? `, ${contents}` : "",
	].join("");
	const metaRef = useOverflowTitle<HTMLParagraphElement>(metaTitle);

	return (
		// `surface-card` + `border-rule`, not a border token: `--border` on `--card` is the same
		// colour in dark, so the row would have no edge (RunItem carries the pair for the same
		// reason). `group relative`: the actions reveal on the row, and the collapsed cluster is
		// positioned against it.
		<div
			// Where a purge hands focus on to (#1234). `tabIndex={-1}` makes the row a `.focus()`
			// target without a tab stop in front of the buttons, and holds while the purge in
			// flight disables them, which is when focus needs somewhere to be.
			data-trash-id={entry.id}
			tabIndex={-1}
			// `focus-row`: the baseline ring, written `[tabindex]:not([tabindex="-1"])`, leaves
			// this composite unmarked.
			className="focus-row group relative surface-card border border-rule rounded-md overflow-hidden w-full"
		>
			<div className="flex items-center gap-2 px-3 py-2 min-w-0">
				<KindIcon className="size-icon shrink-0 text-muted-foreground" aria-hidden="true" />

				<div className="flex-1 min-w-0">
					<TruncatedText className="text-sm text-foreground">{entry.name}</TruncatedText>
					{/*
					 * The kind is written out, not left to the icon: the glyph is `aria-hidden`
					 * decoration (the design system's rule), so with the icon alone a screen reader
					 * gets a name and a date and cannot tell a deleted folder from a request, and a
					 * sighted reader has to know which shape means which.
					 */}
					<p ref={metaRef} className="truncate text-xs text-muted-foreground">
						{kindLabel}
						{/* The owner is what tells two same-named entries apart (#3449). */}
						{entry.parentName ? ` · from ${entry.parentName}` : ""} · Deleted{" "}
						<TimeValue value={entry.deletedAt} style="relative" />
						{contents ? `, ${contents}` : ""}
					</p>
				</div>

				<div
					className={cn("flex items-center gap-1 shrink-0", !busy && ROW_ACTIONS_REVEAL)}
				>
					<TooltipIconButton
						variant="rowAction"
						onClick={() => void copy(trashReference(entry), "Reference")}
						label={`Copy ${entry.name} for agent`}
						tooltip="Copy for agent"
						icon={
							<IconSwap
								state={copied ? "copied" : "copy"}
								icons={{
									copy: <Copy className="size-icon-sm" />,
									copied: (
										<Check className="size-icon-sm text-status-success-text" />
									),
								}}
							/>
						}
					/>
					<TooltipIconButton
						variant="rowAction"
						onClick={() => onRestore(entry)}
						disabled={busy}
						label={`Restore ${entry.name}`}
						tooltip="Restore"
						icon={
							isRestoring ? (
								<Loader2 className="size-icon-sm animate-spin" />
							) : (
								<RotateCcw
									className="size-icon-sm"
									data-icon-motion={ICON_MOTION.spinBack}
								/>
							)
						}
					/>
					<TooltipIconButton
						variant="rowActionDestructive"
						onClick={() => onPurge(entry)}
						disabled={busy}
						label={`Delete ${entry.name} forever`}
						tooltip="Delete forever"
						icon={
							isPurging ? (
								<Loader2 className="size-icon-sm animate-spin" />
							) : (
								<Trash2 className="size-icon-sm" />
							)
						}
					/>
				</div>
			</div>
		</div>
	);
}
