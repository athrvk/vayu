/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ExamplesPanel - the request's saved example responses (issues #481, #588,
 * #722).
 *
 * These are what an importer found next to the request and, until the engine
 * had a table for them, threw away: Postman's saved responses, an OpenAPI
 * operation's documented ones - and, since #588, the responses a user kept from
 * the response viewer. It is also the list of what a mock server for this
 * collection will answer with, the first row of a matched request being the one
 * it serves, which is why the stored order is preserved rather than re-sorted
 * here.
 *
 * Rows can be removed but not edited. Delete landed with save-as-example
 * because an example you can create and never remove is the #553 zombie shape
 * at a smaller scale; an editor for a stored example is a separate change, and
 * this is still a viewer until it exists.
 *
 * **A row says where it came from, because the two kinds behave differently**
 * (#722). A spec sync rewrites a request's imported examples whenever it
 * applies any change to it and never touches a saved one, so which rows the
 * next sync owns is a fact about the list - and until the chip it was one the
 * list did not show. Deleting either kind is durable now: the engine records a
 * deleted imported example rather than only removing it, so this dialog's
 * promise is true for both, and only the wording of what could still bring one
 * back differs.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Trash2 } from "lucide-react";
import { ResponseBody, StatusCodeBadge } from "@/components/shared/response-viewer";
import { Badge, Button, DeleteConfirmDialog } from "@/components/ui";
import { useDeleteRequestExampleMutation, useRequestExamplesQuery } from "@/queries";
import { useRequestBuilderContext } from "../../../context";
import type { RequestExample } from "@/types";

/**
 * The header map `ResponseBody` reads, from the example's stored entries.
 *
 * Disabled rows are dropped and a repeated name keeps its last value: this map
 * exists only so the viewer can pick a renderer, and it is deliberately not the
 * copy shown to the user - `ExampleRow` lists the stored entries themselves, so
 * duplicates stay visible where they matter.
 */
function headerMap(example: RequestExample): Record<string, string> {
	const out: Record<string, string> = {};
	for (const header of example.headers) {
		if (header.enabled) out[header.key] = header.value;
	}
	if (example.contentType && !("Content-Type" in out)) out["Content-Type"] = example.contentType;
	return out;
}

function ExampleRow({
	example,
	onDelete,
	deleting,
}: {
	example: RequestExample;
	onDelete: () => void;
	deleting: boolean;
}) {
	const [open, setOpen] = useState(false);
	const Chevron = open ? ChevronDown : ChevronRight;

	return (
		<div className="rounded-md border border-rule surface-card">
			{/*
			 * The expander and the delete cannot be one button, so the row is a
			 * container that paints the hover and the expander stretches into it -
			 * the drawer-row rule (`drawer-row-hit-area.test.tsx`). Without
			 * `self-stretch` the expander is content-height and the padding above
			 * and below it swallows clicks that look like they land on the row.
			 */}
			<div className="flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-accent">
				<button
					type="button"
					onClick={() => setOpen((v) => !v)}
					aria-expanded={open}
					className="flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-md px-3 py-2 text-left text-xs"
				>
					<Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
					<StatusCodeBadge status={example.status} />
					<span className="truncate font-medium">{example.name}</span>
					{/*
					 * A partial body, said on the row rather than in the name
					 * (issue #659). The name is editable at save time, so it lost
					 * the disclosure to any rename; the engine records
					 * `bodyTruncated` and this reads it.
					 *
					 * Amber, not destructive: a truncated example is a usable
					 * one - a mock will serve it and the response is real as far
					 * as it goes - so the state is "know this", never "broken".
					 * The same reading `DATA_TOKEN_TONE_CLASS` gives `warning`.
					 */}
					{example.bodyTruncated && (
						<Badge
							variant="chip"
							className="shrink-0 border border-warning/30 bg-warning/10 text-warning-text"
							title="Only the first part of the response was captured. A mock server serves this body as though it were the whole response."
						>
							Partial body
						</Badge>
					)}
					{/*
					 * Where the row came from (issue #722). The engine has
					 * recorded it since #588 and the two kinds behave
					 * differently - a sync rewrites the imported rows of a
					 * request it applies any change to, and never the saved
					 * ones - so leaving the asymmetry invisible made the list
					 * unpredictable: nothing on screen said which rows the next
					 * sync would replace.
					 *
					 * Neutral, unlike the amber beside it: this is where a row
					 * came from, not something to watch out for. The muted
					 * text-only chip the settings cards use for the same kind
					 * of fact ("Every port", "Passphrase set") - `chip` paints
					 * no background, so the colour is the caller's to state.
					 */}
					{example.origin === "import" && (
						<Badge
							variant="chip"
							className="shrink-0 text-muted-foreground"
							title="Written by an import or a spec sync. Applying a later sync to this request refreshes it from the document; an example you save from a response is never replaced."
						>
							Imported
						</Badge>
					)}
				</button>
				<Button
					size="icon"
					variant="ghost"
					onClick={onDelete}
					disabled={deleting}
					aria-label={`Delete example ${example.name}`}
					className="h-6 w-6 shrink-0"
				>
					{deleting ? (
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
					) : (
						<Trash2 className="h-3.5 w-3.5" />
					)}
				</Button>
			</div>

			{open && (
				<div className="flex flex-col gap-3 border-t border-rule px-3 py-3">
					{example.headers.length > 0 && (
						<div className="flex flex-col gap-1">
							<div className="text-[11px] uppercase tracking-wide text-subtle-foreground">
								Headers
							</div>
							{example.headers.map((header, i) => (
								<div key={i} className="flex gap-2 font-mono text-[11px]">
									<span className="text-muted-foreground">{header.key}</span>
									<span className="truncate">{header.value}</span>
								</div>
							))}
						</div>
					)}
					<div className="h-64">
						<ResponseBody
							body={example.body}
							headers={headerMap(example)}
							showModeToggle={false}
							compact
						/>
					</div>
				</div>
			)}
		</div>
	);
}

export default function ExamplesPanel() {
	const { request } = useRequestBuilderContext();
	const { data: examples, isLoading, isError } = useRequestExamplesQuery(request.id ?? null);
	const [pendingDelete, setPendingDelete] = useState<RequestExample | null>(null);
	const deleteExample = useDeleteRequestExampleMutation();

	const confirmDelete = () => {
		if (!request.id || !pendingDelete) return;
		deleteExample.mutate(
			{ requestId: request.id, exampleId: pendingDelete.id },
			{ onSuccess: () => setPendingDelete(null) }
		);
	};

	// An unsaved request has no id, so there is nothing stored to list - said
	// plainly rather than shown as an empty list, which would read as "this
	// request has no examples" for a request that cannot have any yet.
	if (!request.id) {
		return (
			<p className="text-xs text-muted-foreground">
				Save this request to see the example responses stored against it.
			</p>
		);
	}
	if (isLoading) {
		return <p className="text-xs text-muted-foreground">Loading examples…</p>;
	}
	if (isError) {
		return <p className="text-xs text-status-error-text">Could not load example responses.</p>;
	}
	if (!examples || examples.length === 0) {
		return (
			<p className="text-xs text-muted-foreground">
				No example responses. Send this request and use{" "}
				<span className="font-medium">Save as example</span> to keep the response, or import
				a Postman collection with saved responses or an OpenAPI spec that documents them.
			</p>
		);
	}

	return (
		<div className="flex flex-col gap-2">
			{examples.map((example) => (
				<ExampleRow
					key={example.id}
					example={example}
					onDelete={() => {
						// Clears the previous refusal, so reopening does not lead
						// with the error from the attempt before it.
						deleteExample.reset();
						setPendingDelete(example);
					}}
					deleting={deleteExample.isPending && pendingDelete?.id === example.id}
				/>
			))}

			{/*
			 * Confirmed rather than immediate: a mock server answers with the first
			 * example of a matched route, so removing one can change what the next
			 * restart serves.
			 *
			 * The second sentence differs by origin because what happens next
			 * does (issue #722). A saved example is simply gone. An imported one
			 * is gone too - the engine keeps the delete as a tombstone, so no
			 * later sync writes it back - but re-importing the document is a
			 * fresh import and does bring it back, which is the one way it can
			 * return and so the one thing worth saying here.
			 */}
			<DeleteConfirmDialog
				open={!!pendingDelete}
				onOpenChange={(open) => !open && setPendingDelete(null)}
				title="Delete example?"
				description={
					<>
						<span className="font-medium">{pendingDelete?.name}</span> is removed from
						this request. A mock server for this collection stops answering with it once
						it is restarted.{" "}
						{pendingDelete?.origin === "import"
							? "Syncing this collection with its spec will not bring it back; re-importing the document will."
							: "Nothing here can bring it back."}
						{/* The engine's refusal, in the dialog that asked for the delete.
						    Without it a failed delete looks like nothing happened: the row
						    is still there and the dialog is still open. */}
						{deleteExample.error && (
							<span className="mt-2 block text-status-error-text">
								Could not delete it: {deleteExample.error.message}
							</span>
						)}
					</>
				}
				onConfirm={confirmDelete}
				isDeleting={deleteExample.isPending}
			/>
		</div>
	);
}
