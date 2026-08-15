/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Spec tab's Sync section - re-read the bound document, say what moved, and
 * apply the parts the user ticks (issues #654 and #655, phase 2 of #625).
 *
 * The read half and the write half stayed separate all the way down. Every
 * judgement about what changed lives in `spec-diff`, and every judgement about
 * what to *write* lives in `spec-apply`; both are pure, so the rules that
 * matter - a field somebody edited is never overwritten unless they ask, a
 * removal is never a default - are provable without a row to damage. This
 * component ticks boxes and calls one engine route.
 *
 * **Applying is one call because it has to be one transaction.** `POST
 * /specs/sync` writes the document, moves the binding and applies the rows
 * together; a sync that stopped halfway would leave the collection bound to a
 * document its requests do not reflect, which is the state binding exists to
 * make impossible.
 *
 * The counts are stated in full, zeros included, for the reason `MatchSummary`
 * states its three: "4 changed" alone reads as the whole answer, while "4
 * changed, 0 added, 0 removed, 12 unchanged" is the answer.
 */

import { useState } from "react";
import { AlertTriangle, Check, Loader2, RefreshCw, Upload } from "lucide-react";

import { Button, DeleteConfirmDialog } from "@/components/ui";
import { Callout } from "@/components/shared";
import { apiService } from "@/services/api";
import { useSpecDocumentLimit } from "@/hooks/useSpecDocumentLimit";
import { useSyncSpecMutation } from "@/queries/specs";
import {
	diffSpec,
	type ChangedRequest,
	type SpecDiff,
	type SpecField,
} from "@/services/openapi/spec-diff";
import {
	buildSyncPayload,
	defaultSelection,
	isEmptySelection,
	operationKey,
	type SpecApplySelection,
} from "@/services/openapi/spec-apply";
import { readSpecOperations, type SpecRequestDraft } from "@/services/openapi/spec-operations";
import { refetchSpec } from "@/services/openapi/spec-refetch";
import type { SpecFileLocation } from "@/stores";
import type { Collection, Request, SpecDocument } from "@/types";
import { SaveFailed, SectionLabel } from "./shared";

interface SpecSyncProps {
	/** The bound collection - what a sync is allowed to write, and where it writes. */
	collection: Collection;
	/** Every stored collection, to find the tag folder an added operation lands in. */
	collections: readonly Collection[];
	/** The bound document, or `undefined` while the engine has not answered. */
	spec: SpecDocument | undefined;
	/** Where this machine keeps the picked file, when it was this machine that picked it. */
	specFile: SpecFileLocation | undefined;
	/** Every request beneath the bound collection - the same set the counts describe. */
	requests: Request[];
}

type CheckState =
	| { phase: "idle" }
	| { phase: "checking" }
	| { phase: "error"; message: string }
	| { phase: "unchanged" }
	| {
			phase: "diff";
			diff: SpecDiff;
			unresolvedRefs: number;
			/** The bytes that were diffed, and the ones an apply stores - never a re-fetch. */
			content: string;
			selection: SpecApplySelection;
	  }
	| { phase: "applied"; created: number; updated: number; deleted: number };

export default function SpecSync({
	collection,
	collections,
	spec,
	specFile,
	requests,
}: SpecSyncProps) {
	const { maxBytes } = useSpecDocumentLimit();
	const [state, setState] = useState<CheckState>({ phase: "idle" });
	const [confirmingDeletes, setConfirmingDeletes] = useState(false);
	const syncSpec = useSyncSpecMutation();

	const handleCheck = async () => {
		if (!spec || state.phase === "checking") return;
		setState({ phase: "checking" });
		try {
			const { text, unresolvedRefs } = await refetchSpec(
				{
					sourceUrl: spec.sourceUrl,
					...(specFile ? { file: specFile } : {}),
				},
				{
					maxBytes,
					fetchUrl: async (url) => (await apiService.importFetch(url)).content,
					...(window.electronAPI?.readSpecFile
						? { readSpecFile: window.electronAPI.readSpecFile }
						: {}),
				}
			);

			// The bytes, not a second hash of them: the engine hashes what it
			// stores (`spec_content_hash`), this holds exactly those bytes, and a
			// SHA-256 in the renderer would be a copy of that rule with its own
			// way of being wrong.
			if (text === spec.content) {
				setState({ phase: "unchanged" });
				return;
			}

			const fetched = readSpecOperations(text).requests;
			const diff = diffSpec({ bound: boundDrafts(spec.content), fetched, requests });
			setState({
				phase: "diff",
				diff,
				unresolvedRefs,
				content: text,
				selection: defaultSelection(diff),
			});
		} catch (e) {
			setState({ phase: "error", message: (e as Error).message });
		}
	};

	const setSelection = (next: SpecApplySelection) =>
		setState((current) =>
			current.phase === "diff" ? { ...current, selection: next } : current
		);

	const handleApply = () => {
		if (state.phase !== "diff" || !spec) return;
		const payload = buildSyncPayload({
			collectionId: collection.id,
			diff: state.diff,
			selection: state.selection,
			content: state.content,
			// The document is re-fetched from the source the binding recorded, so
			// the new row records the same one - a file-sourced document keeps
			// having no URL rather than acquiring one.
			sourceUrl: spec.sourceUrl,
			collections,
		});
		syncSpec.mutate(payload, {
			onSuccess: (result) => {
				setConfirmingDeletes(false);
				setState({
					phase: "applied",
					created: result.created,
					updated: result.updated,
					deleted: result.deleted,
				});
			},
		});
	};

	const pendingDeletes = state.phase === "diff" ? state.selection.removed.size : 0;

	return (
		<div>
			<SectionLabel>Sync</SectionLabel>
			<div className="rounded-md border border-rule bg-card surface-card p-3 space-y-3">
				<div className="flex items-center gap-2">
					<Button
						variant="outline"
						onClick={() => void handleCheck()}
						disabled={!spec || state.phase === "checking" || syncSpec.isPending}
					>
						{state.phase === "checking" ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<RefreshCw className="mr-2 h-4 w-4" />
						)}
						Check for changes
					</Button>
					<span className="text-[11px] text-muted-foreground">
						Re-reads the document and compares it. Nothing is written until you apply.
					</span>
				</div>

				{!spec && (
					<p className="text-[11px] text-muted-foreground">
						The stored document has to load before it can be compared.
					</p>
				)}

				{state.phase === "error" && (
					<Callout severity="blocking" title="Couldn't check this document">
						{state.message}
					</Callout>
				)}

				{state.phase === "unchanged" && (
					<p className="flex items-center gap-2 text-xs text-status-success-text">
						<Check className="h-3.5 w-3.5 shrink-0" />
						Up to date - the document is byte for byte the one this collection is bound
						to.
					</p>
				)}

				{state.phase === "applied" && (
					<p className="flex items-center gap-2 text-xs text-status-success-text">
						<Check className="h-3.5 w-3.5 shrink-0" />
						Applied - {state.created} request{state.created === 1 ? "" : "s"} created,{" "}
						{state.updated} updated, {state.deleted} deleted. This collection is now
						bound to the document you just synced.
					</p>
				)}

				{state.phase === "diff" && (
					<>
						<DiffReport
							diff={state.diff}
							unresolvedRefs={state.unresolvedRefs}
							selection={state.selection}
							onChange={setSelection}
						/>
						<div className="flex items-center gap-2">
							<Button
								onClick={() =>
									pendingDeletes > 0 ? setConfirmingDeletes(true) : handleApply()
								}
								disabled={isEmptySelection(state.selection) || syncSpec.isPending}
							>
								{syncSpec.isPending ? (
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								) : (
									<Upload className="mr-2 h-4 w-4" />
								)}
								Apply selected
							</Button>
							<span className="text-[11px] text-muted-foreground">
								{applySummary(state.selection)}
							</span>
						</div>
					</>
				)}

				<SaveFailed mutation={syncSpec} what="this sync" />
			</div>

			{/*
			 * The count-naming confirm every destructive path here uses. A sync can
			 * delete several requests in one click, and the number is the part a
			 * user needs before agreeing - "delete the removed operations" is not
			 * something anyone can weigh.
			 */}
			<DeleteConfirmDialog
				open={confirmingDeletes}
				onOpenChange={setConfirmingDeletes}
				title="Delete requests this document no longer declares?"
				description={
					<>
						{pendingDeletes} request{pendingDeletes === 1 ? "" : "s"} will be deleted,
						with everything saved on {pendingDeletes === 1 ? "it" : "them"}. The rest of
						this sync is applied in the same step.
					</>
				}
				onConfirm={handleApply}
				isDeleting={syncSpec.isPending}
				confirmLabel="Apply and delete"
			/>
		</div>
	);
}

/**
 * The bound document as drafts, or `null` when it cannot be read.
 *
 * `null` rather than an exception: a stored document Vayu can no longer parse
 * is a reason to compare two-way and say so per request, not a reason to refuse
 * to tell the user what the *new* document says.
 */
function boundDrafts(content: string): SpecRequestDraft[] | null {
	try {
		return readSpecOperations(content).requests;
	} catch {
		return null;
	}
}

/** "3 to create, 1 to update, 0 to delete" - what the button is about to do. */
function applySummary(selection: SpecApplySelection): string {
	if (isEmptySelection(selection)) return "Nothing selected.";
	return (
		`${selection.added.size} to create · ${selection.changed.size} to update · ` +
		`${selection.removed.size} to delete`
	);
}

interface SelectionProps {
	selection: SpecApplySelection;
	onChange: (next: SpecApplySelection) => void;
}

function DiffReport({
	diff,
	unresolvedRefs,
	selection,
	onChange,
}: { diff: SpecDiff; unresolvedRefs: number } & SelectionProps) {
	const toggleAdded = (key: string, on: boolean) => {
		const added = new Set(selection.added);
		if (on) added.add(key);
		else added.delete(key);
		onChange({ ...selection, added });
	};

	const toggleRemoved = (id: string, on: boolean) => {
		const removed = new Set(selection.removed);
		if (on) removed.add(id);
		else removed.delete(id);
		onChange({ ...selection, removed });
	};

	const setChanged = (id: string, fields: ReadonlySet<SpecField> | null) => {
		const changed = new Map(selection.changed);
		if (fields) changed.set(id, fields);
		else changed.delete(id);
		onChange({ ...selection, changed });
	};

	return (
		<div className="space-y-3">
			<div className="rounded-md border border-rule surface-sunken p-3 space-y-1">
				<p className="text-xs font-semibold">The document has changed</p>
				<p className="text-[11px] text-muted-foreground">
					{diff.added.length} new operation{diff.added.length === 1 ? "" : "s"} ·{" "}
					{diff.removed.length} request{diff.removed.length === 1 ? "" : "s"} whose
					operation is gone · {diff.changed.length} changed · {diff.unchanged} unchanged
				</p>
				{diff.unmapped > 0 && (
					<p className="text-[11px] text-muted-foreground">
						{diff.unmapped} request{diff.unmapped === 1 ? "" : "s"} carry no operation
						and {diff.unmapped === 1 ? "is" : "are"} not part of this comparison.
					</p>
				)}
			</div>

			{unresolvedRefs > 0 && (
				<Callout severity="warning" title="Some references could not be read">
					{unresolvedRefs} reference{unresolvedRefs === 1 ? "" : "s"} to another file
					could not be followed, so whatever they describe is missing from this
					comparison.
				</Callout>
			)}

			{diff.added.length > 0 && (
				<Group
					title="New operations"
					hint="Ticked ones become requests, filed by tag the way an import files them."
				>
					{diff.added.map((entry) => (
						<CheckRow
							key={operationKey(entry.operation)}
							checked={selection.added.has(operationKey(entry.operation))}
							onChange={(on) => toggleAdded(operationKey(entry.operation), on)}
							title={entry.draft.name}
							detail={operationKey(entry.operation)}
							note={entry.folder ? `into ${entry.folder}` : undefined}
						/>
					))}
				</Group>
			)}

			{diff.removed.length > 0 && (
				<Group
					title="Operations the document no longer declares"
					hint="Unticked by default - deleting a request takes everything saved on it."
				>
					{diff.removed.map((request) => (
						<CheckRow
							key={request.id}
							checked={selection.removed.has(request.id)}
							onChange={(on) => toggleRemoved(request.id, on)}
							title={request.name}
							detail={
								request.specOperation
									? operationKey(request.specOperation)
									: request.url
							}
							note="delete"
						/>
					))}
				</Group>
			)}

			{diff.changed.length > 0 && (
				<Group
					title="Changed"
					hint="Tick the fields to take from the document. Ones you changed yourself start unticked."
				>
					{diff.changed.map((changed) => (
						<ChangedRow
							key={changed.request.id}
							changed={changed}
							fields={selection.changed.get(changed.request.id)}
							onChange={(fields) => setChanged(changed.request.id, fields)}
						/>
					))}
				</Group>
			)}

			<p className="text-[11px] text-muted-foreground">
				Applying a change also refreshes that request&rsquo;s response examples from the
				document - the ones a previous import or sync wrote. Examples you saved from a live
				response are never replaced.
			</p>
		</div>
	);
}

function ChangedRow({
	changed,
	fields,
	onChange,
}: {
	changed: ChangedRequest;
	/** The ticked fields, or `undefined` when this request is not being applied. */
	fields: ReadonlySet<SpecField> | undefined;
	onChange: (fields: ReadonlySet<SpecField> | null) => void;
}) {
	const applying = fields !== undefined;

	const toggleField = (field: SpecField, on: boolean) => {
		const next = new Set(fields ?? []);
		if (on) next.add(field);
		else next.delete(field);
		onChange(next);
	};

	return (
		<li className="rounded-md border border-rule surface-sunken p-2 space-y-1">
			<label className="flex items-baseline gap-2">
				<input
					type="checkbox"
					checked={applying}
					onChange={(e) =>
						onChange(
							e.target.checked
								? new Set(
										changed.fields
											.filter((field) => !field.userTouched)
											.map((field) => field.field)
									)
								: null
						)
					}
					aria-label={`Apply changes to ${changed.request.name}`}
				/>
				<span className="text-xs font-medium">{changed.request.name}</span>
				<span className="text-[11px] font-mono text-muted-foreground break-all">
					{operationKey(changed.operation)}
				</span>
			</label>

			{changed.renamed && (
				<p className="text-[11px] text-muted-foreground">
					Followed by its {changed.matchedBy === "operationId" ? "operationId" : "path"}:
					this request records {operationKey(changed.boundOperation)}, and applying
					records the new identity.
				</p>
			)}

			{changed.previousUnknown && (
				<p className="text-[11px] text-muted-foreground">
					The bound document does not describe this operation, so an edit of yours and a
					change of the document&rsquo;s cannot be told apart here - nothing is ticked for
					you.
				</p>
			)}

			{changed.fields.length > 0 && (
				<ul className="space-y-1">
					{changed.fields.map((field) => (
						<li key={field.field} className="text-[11px]">
							<label className="flex items-baseline gap-1.5">
								<input
									type="checkbox"
									checked={fields?.has(field.field) ?? false}
									disabled={!applying}
									onChange={(e) => toggleField(field.field, e.target.checked)}
									aria-label={`Apply ${field.field} to ${changed.request.name}`}
								/>
								<span className="font-semibold">{field.field}</span>
								{field.userTouched && (
									<span className="text-status-warning-text">
										<AlertTriangle className="mr-1 inline h-3 w-3 align-[-1px]" />
										edited here
									</span>
								)}
							</label>
							<span className="block pl-5 text-muted-foreground break-all">
								{field.current || "empty"} &rarr; {field.next || "empty"}
							</span>
						</li>
					))}
				</ul>
			)}
		</li>
	);
}

function Group({
	title,
	hint,
	children,
}: {
	title: string;
	hint: string;
	children: React.ReactNode;
}) {
	return (
		<div>
			<p className="text-[11px] font-semibold">{title}</p>
			<p className="mb-1.5 text-[11px] text-muted-foreground">{hint}</p>
			<ul className="space-y-1.5">{children}</ul>
		</div>
	);
}

function CheckRow({
	checked,
	onChange,
	title,
	detail,
	note,
}: {
	checked: boolean;
	onChange: (on: boolean) => void;
	title: string;
	detail: string;
	note?: string;
}) {
	return (
		<li className="rounded-md border border-rule surface-sunken p-2">
			<label className="flex items-baseline gap-2">
				<input
					type="checkbox"
					checked={checked}
					onChange={(e) => onChange(e.target.checked)}
					aria-label={`${title} (${detail})`}
				/>
				<span className="text-xs font-medium">{title}</span>
				<span className="text-[11px] font-mono text-muted-foreground break-all">
					{detail}
				</span>
				{note && <span className="text-[11px] text-muted-foreground">{note}</span>}
			</label>
		</li>
	);
}
