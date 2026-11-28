/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Import dialog's report on an MCP server it has imported before (#3842): what the server lists
 * now, set against each collection an earlier import of it built, so a renamed tool reads as one
 * change rather than as a second collection. Each row is ticked to be written to that collection
 * (#3994), the way `SpecSync` ticks what a document moved: added and changed start ticked, and a
 * removal never does, since deleting a request takes everything saved on it.
 *
 * Controlled: the ticks live with the dialog, whose footer holds the action that writes them (and
 * the request the diff was computed from), so this draws the rows and reports a tick.
 */

import { Button, Checkbox } from "@/components/ui";
import { pluralize } from "@/modules/dashboard/utils/format";
import type {
	ImportMcpDiffAdded,
	ImportMcpDiffChanged,
	ImportMcpDiffMatch,
	ImportMcpDiffKind,
} from "@/types";
import {
	addedRowId,
	isEmptyMcpSelection,
	withTicked,
	type McpSelection,
} from "./mcp-reimport-selection";

const FIELD_LABELS: Record<ImportMcpDiffChanged["fields"][number], string> = {
	description: "description",
	inputSchema: "input schema",
	outputSchema: "output schema",
};

/** One line of a list: what it is called, what kind of entry it is, and what moved about it. */
interface DiffRow {
	id: string;
	label: string;
	kind: ImportMcpDiffKind;
	detail?: string;
}

function addedRow(entry: ImportMcpDiffAdded): DiffRow {
	return { id: addedRowId(entry), label: entry.name, kind: entry.kind };
}

/** A rename reads `old → new`; `fields` may be empty for one, and a rename with edits states both. */
function changedRow(entry: ImportMcpDiffChanged): DiffRow {
	const moved = entry.fields.map((field) => FIELD_LABELS[field]);
	const detail = [...(entry.renamedFrom === undefined ? [] : ["renamed"]), ...moved].join(", ");
	return {
		id: entry.requestId,
		label: entry.renamedFrom === undefined ? entry.name : `${entry.renamedFrom} → ${entry.key}`,
		kind: entry.kind,
		...(detail === "" ? {} : { detail }),
	};
}

interface DiffListProps {
	title: string;
	hint: string;
	rows: DiffRow[];
	ticked: ReadonlySet<string>;
	onTick: (id: string, on: boolean) => void;
	disabled: boolean;
}

function DiffList({ title, hint, rows, ticked, onTick, disabled }: DiffListProps) {
	if (rows.length === 0) return null;
	return (
		<div>
			<p className="text-label font-semibold">{title}</p>
			<p className="mb-1 text-label text-muted-foreground">{hint}</p>
			<ul className="space-y-0.5">
				{rows.map((row) => (
					<li key={row.id} className="text-label">
						<label className="flex flex-wrap items-center gap-x-2">
							<Checkbox
								checked={ticked.has(row.id)}
								disabled={disabled}
								onChange={(e) => onTick(row.id, e.target.checked)}
								aria-label={`${row.label} (${row.kind})`}
								// `size-target`, not `size-icon`: a bare checkbox is its own hit target,
								// and `items-center` keeps one this size level with a single-line label.
								className="size-target"
							/>
							<span className="font-mono break-all">{row.label}</span>
							<span className="text-muted-foreground">
								{row.kind}
								{row.detail ? ` - ${row.detail}` : ""}
							</span>
						</label>
					</li>
				))}
			</ul>
		</div>
	);
}

interface MatchReportProps {
	match: ImportMcpDiffMatch;
	selection: McpSelection;
	onSelectionChange: (next: McpSelection) => void;
	disabled: boolean;
	/** Set when this match carries its own action, as it does with several matches. */
	onUpdate?: () => void;
}

function MatchReport({
	match,
	selection,
	onSelectionChange,
	disabled,
	onUpdate,
}: MatchReportProps) {
	const { added, changed, removed } = match;
	const tick = (key: keyof McpSelection) => (id: string, on: boolean) =>
		onSelectionChange({ ...selection, [key]: withTicked(selection[key], id, on) });
	return (
		<div role="group" aria-label={match.name} className="space-y-1.5">
			<p className="text-xs font-medium">{match.name}</p>
			<p className="text-label text-muted-foreground">
				{added.length} added · {changed.length} changed · {removed.length} removed
			</p>
			{match.identical && (
				<p className="text-label text-muted-foreground">
					Nothing differs: the server lists what this collection holds.
				</p>
			)}
			<DiffList
				title="Added"
				hint="Ticked ones become requests, filed under Tools, Resources or Prompts by kind."
				rows={added.map(addedRow)}
				ticked={selection.added}
				onTick={tick("added")}
				disabled={disabled}
			/>
			<DiffList
				title="Changed"
				hint="Ticked ones are updated in place: only the fields listed, and a rename, are written."
				rows={changed.map(changedRow)}
				ticked={selection.changed}
				onTick={tick("changed")}
				disabled={disabled}
			/>
			<DiffList
				title="Removed"
				hint="Unticked by default - deleting a request takes everything saved on it."
				rows={removed.map((entry) => ({ ...addedRow(entry), id: entry.requestId }))}
				ticked={selection.removed}
				onTick={tick("removed")}
				disabled={disabled}
			/>
			{onUpdate && (
				<Button
					variant="outline"
					size="sm"
					onClick={onUpdate}
					disabled={disabled || isEmptyMcpSelection(selection)}
				>
					Update existing
				</Button>
			)}
		</div>
	);
}

interface McpReimportDiffProps {
	matches: readonly ImportMcpDiffMatch[];
	/** The ticks of one match: its defaults until the user moves one. */
	selectionFor: (match: ImportMcpDiffMatch) => McpSelection;
	onSelectionChange: (collectionId: string, next: McpSelection) => void;
	/** An update is being written, or nothing may be ticked for another reason. */
	disabled?: boolean;
	/**
	 * Writes the ticked rows of one match. Given, each match draws its own action: a footer's one
	 * button cannot say which of several collections it updates, so the dialog passes this only then.
	 */
	onUpdate?: (collectionId: string) => void;
}

export function McpReimportDiff({
	matches,
	selectionFor,
	onSelectionChange,
	disabled = false,
	onUpdate,
}: McpReimportDiffProps) {
	return (
		<section
			aria-label="Earlier import of this server"
			className="space-y-3 rounded-md border border-rule surface-sunken p-3"
		>
			<div className="space-y-1">
				<p className="text-xs font-semibold">You already imported this server</p>
				<p className="text-label text-muted-foreground">
					What the server lists now, set against the{" "}
					{pluralize(matches.length, "collection")} an earlier import made. Update
					existing writes the ticked rows to the collection they are listed under; Import
					anyway creates a new collection and leaves the existing{" "}
					{pluralize(matches.length, "one", "ones")} as{" "}
					{pluralize(matches.length, "it is", "they are")}.
				</p>
			</div>
			{matches.map((match) => (
				<MatchReport
					key={match.collectionId}
					match={match}
					selection={selectionFor(match)}
					onSelectionChange={(next) => onSelectionChange(match.collectionId, next)}
					disabled={disabled}
					{...(onUpdate ? { onUpdate: () => onUpdate(match.collectionId) } : {})}
				/>
			))}
		</section>
	);
}
