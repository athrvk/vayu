/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Import dialog's report on an MCP server it has imported before (#3842): what the server lists
 * now, set against each collection an earlier import of it built, so a renamed tool reads as one
 * change rather than as a second collection. Read-only. The one way forward is Import, which makes
 * a new collection as it always did; applying the difference to the existing one is not offered,
 * and the copy says so rather than leaving the user to look for it.
 */

import { pluralize } from "@/modules/dashboard/utils/format";
import type {
	ImportMcpDiffAdded,
	ImportMcpDiffChanged,
	ImportMcpDiffMatch,
	ImportMcpDiffKind,
} from "@/types";

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
	return { id: `${entry.kind}:${entry.key}`, label: entry.name, kind: entry.kind };
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

function DiffList({ title, rows }: { title: string; rows: DiffRow[] }) {
	if (rows.length === 0) return null;
	return (
		<div>
			<p className="text-label font-semibold">{title}</p>
			<ul className="space-y-0.5">
				{rows.map((row) => (
					<li key={row.id} className="flex flex-wrap items-baseline gap-x-2 text-label">
						<span className="font-mono break-all">{row.label}</span>
						<span className="text-muted-foreground">
							{row.kind}
							{row.detail ? ` - ${row.detail}` : ""}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function MatchReport({ match }: { match: ImportMcpDiffMatch }) {
	const { added, changed, removed } = match;
	return (
		<div className="space-y-1.5">
			<p className="text-xs font-medium">{match.name}</p>
			<p className="text-label text-muted-foreground">
				{added.length} added · {changed.length} changed · {removed.length} removed
			</p>
			{match.identical && (
				<p className="text-label text-muted-foreground">
					Nothing differs: the server lists what this collection holds.
				</p>
			)}
			<DiffList title="Added" rows={added.map(addedRow)} />
			<DiffList title="Changed" rows={changed.map(changedRow)} />
			<DiffList
				title="Removed"
				rows={removed.map((entry) => ({ ...addedRow(entry), id: entry.requestId }))}
			/>
		</div>
	);
}

export function McpReimportDiff({ matches }: { matches: readonly ImportMcpDiffMatch[] }) {
	return (
		<section
			aria-label="Earlier import of this server"
			className="space-y-3 rounded-md border border-rule surface-sunken p-3"
		>
			<div className="space-y-1">
				<p className="text-xs font-semibold">You already imported this server</p>
				<p className="text-label text-muted-foreground">
					What the server lists now, set against the{" "}
					{pluralize(matches.length, "collection")} an earlier import made. Import anyway
					creates a new collection; nothing is changed in the existing{" "}
					{pluralize(matches.length, "one", "ones")}.
				</p>
			</div>
			{matches.map((match) => (
				<MatchReport key={match.collectionId} match={match} />
			))}
		</section>
	);
}
