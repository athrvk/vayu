/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Spec tab's Sync section - re-read the bound document and say what moved
 * (issue #654, phase 2b of #625).
 *
 * **It writes nothing, and says so.** Every judgement a sync makes lives in
 * `spec-diff`, where it is provable without a row to damage; this section shows
 * that judgement and stops. Applying it - creating the added, deleting the
 * removed, rewriting the changed while protecting what the user edited - is
 * #655, and until it lands "check" is a question the user can ask as often as
 * they like with nothing at stake.
 *
 * The counts are stated in full, zeros included, for the reason `MatchSummary`
 * states its three: "4 changed" alone reads as the whole answer, while "4
 * changed, 0 added, 0 removed, 12 unchanged" is the answer.
 */

import { useState } from "react";
import { AlertTriangle, Check, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui";
import { Callout } from "@/components/shared";
import { apiService } from "@/services/api";
import { useSpecDocumentLimit } from "@/hooks/useSpecDocumentLimit";
import { diffSpec, type ChangedRequest, type SpecDiff } from "@/services/openapi/spec-diff";
import { readSpecOperations, type SpecRequestDraft } from "@/services/openapi/spec-operations";
import { refetchSpec } from "@/services/openapi/spec-refetch";
import type { SpecFileLocation } from "@/stores";
import type { Request, SpecDocument, SpecOperation } from "@/types";
import { SectionLabel } from "./shared";

interface SpecSyncProps {
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
	| { phase: "diff"; diff: SpecDiff; unresolvedRefs: number };

export default function SpecSync({ spec, specFile, requests }: SpecSyncProps) {
	const { maxBytes } = useSpecDocumentLimit();
	const [state, setState] = useState<CheckState>({ phase: "idle" });

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
			setState({
				phase: "diff",
				diff: diffSpec({ bound: boundDrafts(spec.content), fetched, requests }),
				unresolvedRefs,
			});
		} catch (e) {
			setState({ phase: "error", message: (e as Error).message });
		}
	};

	return (
		<div>
			<SectionLabel>Sync</SectionLabel>
			<div className="rounded-md border border-rule bg-card surface-card p-3 space-y-3">
				<div className="flex items-center gap-2">
					<Button
						variant="outline"
						onClick={() => void handleCheck()}
						disabled={!spec || state.phase === "checking"}
					>
						{state.phase === "checking" ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<RefreshCw className="mr-2 h-4 w-4" />
						)}
						Check for changes
					</Button>
					<span className="text-[11px] text-muted-foreground">
						Re-reads the document and compares it. Nothing is written.
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

				{state.phase === "diff" && (
					<DiffReport diff={state.diff} unresolvedRefs={state.unresolvedRefs} />
				)}
			</div>
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

function DiffReport({ diff, unresolvedRefs }: { diff: SpecDiff; unresolvedRefs: number }) {
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
				<Group title="New operations" hint="No request in this collection is one of these.">
					{diff.added.map((entry) => (
						<Row
							key={operationKey(entry.operation)}
							title={entry.draft.name}
							detail={operationKey(entry.operation)}
						/>
					))}
				</Group>
			)}

			{diff.removed.length > 0 && (
				<Group
					title="Operations the document no longer declares"
					hint="These requests are still here, and stay here."
				>
					{diff.removed.map((request) => (
						<Row
							key={request.id}
							title={request.name}
							detail={
								request.specOperation
									? operationKey(request.specOperation)
									: request.url
							}
						/>
					))}
				</Group>
			)}

			{diff.changed.length > 0 && (
				<Group title="Changed" hint="What the document now produces, field by field.">
					{diff.changed.map((changed) => (
						<ChangedRow key={changed.request.id} changed={changed} />
					))}
				</Group>
			)}

			<p className="text-[11px] text-muted-foreground">
				Nothing has been changed. Response examples are not compared yet - which of them a
				sync may replace is decided where a sync applies.
			</p>
		</div>
	);
}

function ChangedRow({ changed }: { changed: ChangedRequest }) {
	return (
		<li className="rounded-md border border-rule surface-sunken p-2 space-y-1">
			<div className="flex items-baseline gap-2">
				<span className="text-xs font-medium">{changed.request.name}</span>
				<span className="text-[11px] font-mono text-muted-foreground break-all">
					{operationKey(changed.operation)}
				</span>
			</div>

			{changed.renamed && (
				<p className="text-[11px] text-muted-foreground">
					Followed by its {changed.matchedBy === "operationId" ? "operationId" : "path"}:
					this request records {operationKey(changed.boundOperation)}.
				</p>
			)}

			{changed.previousUnknown && (
				<p className="text-[11px] text-muted-foreground">
					The bound document does not describe this operation, so an edit of yours and a
					change of the document&rsquo;s cannot be told apart here.
				</p>
			)}

			{changed.fields.length > 0 && (
				<ul className="space-y-1">
					{changed.fields.map((field) => (
						<li key={field.field} className="text-[11px]">
							<span className="font-semibold">{field.field}</span>
							{field.userTouched && (
								<span className="ml-1.5 text-status-warning-text">
									<AlertTriangle className="mr-1 inline h-3 w-3 align-[-1px]" />
									edited here
								</span>
							)}
							<span className="block text-muted-foreground break-all">
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

function Row({ title, detail }: { title: string; detail: string }) {
	return (
		<li className="rounded-md border border-rule surface-sunken p-2">
			<span className="text-xs font-medium">{title}</span>
			<span className="ml-2 text-[11px] font-mono text-muted-foreground break-all">
				{detail}
			</span>
		</li>
	);
}

/** `GET /pets/{petId}` - how a user recognises an operation, id or no id. */
function operationKey(operation: SpecOperation): string {
	return `${operation.method.toUpperCase()} ${operation.path}`;
}
