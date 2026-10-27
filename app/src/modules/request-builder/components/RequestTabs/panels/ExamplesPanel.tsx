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
 * list did not show. Deleting either kind is durable: the engine records a
 * deleted imported example as a tombstone, and moves a saved one to the Trash
 * (#2971), which is why only a saved delete raises the Undo toast and why the
 * dialog's wording of what could bring the row back differs.
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Trash2 } from "lucide-react";
import {
	Callout,
	CopyForAgentButton,
	DetailSkeleton,
	EmptyState,
	ErrorState,
} from "@/components/shared";
import { ResponseBody, StatusCodeBadge } from "@/components/shared/response-viewer";
import {
	Badge,
	Button,
	DeleteConfirmDialog,
	exampleDeleteDescription,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	ToggleGroup,
	ToggleGroupItem,
} from "@/components/ui";
import {
	useCollectionsQuery,
	useDeleteRequestExampleMutation,
	useRequestExamplesQuery,
	useRequestQuery,
	useUpdateRequestMutation,
} from "@/queries";
import { useTrashUndo } from "@/hooks/useTrashUndo";
import { exampleReference } from "@/lib/agent-reference";
import { collectionNamePath } from "@/modules/collections/tree-utils";
import { useImportModalStore } from "@/stores";
import { useRequestBuilderContext } from "../../../context";
import type { MockResponseMode, Request, RequestExample } from "@/types";
import { Eyebrow } from "@/components/ui/eyebrow";

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
	reference,
	onDelete,
	deleting,
}: {
	example: RequestExample;
	/** The agent reference line, or null while the saved request it names is loading. */
	reference: string | null;
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
					<Chevron className="size-icon-sm shrink-0 text-muted-foreground" />
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
				{reference !== null && (
					<CopyForAgentButton
						reference={reference}
						label={`Copy example ${example.name} for agent`}
					/>
				)}
				<Button
					size="icon"
					variant="rowActionDestructive"
					onClick={onDelete}
					disabled={deleting}
					aria-label={`Delete example ${example.name}`}
					className="shrink-0"
				>
					{deleting ? (
						<Loader2 className="size-icon-sm animate-spin" />
					) : (
						<Trash2 className="size-icon-sm" />
					)}
				</Button>
			</div>

			{open && (
				<div className="enter-fade flex flex-col gap-3 border-t border-rule px-3 py-3">
					{example.headers.length > 0 && (
						<div className="flex flex-col gap-1">
							<Eyebrow>Headers</Eyebrow>
							{example.headers.map((header, i) => (
								<div key={i} className="flex gap-2 font-mono text-label">
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

/**
 * Which saved example a mock server answers with (issue #481 phase 3).
 *
 * A property of the request, not of any running mock - editing it here takes
 * effect the next time a mock for this collection starts, exactly like every
 * other change to a saved example does.
 *
 * `mockResponseMode`/`mockExampleId` live on the persisted `Request` and are
 * written immediately through `useUpdateRequestMutation`, not through the
 * builder's dirty/save flow - `RequestState` (the context's `request`) never
 * carries them, so the caller passes the query-backed row instead.
 */
function MockResponseModeControl({
	request,
	examples,
}: {
	request: Request;
	examples: RequestExample[];
}) {
	const updateRequest = useUpdateRequestMutation();
	const mode = request.mockResponseMode;

	const setMode = (next: MockResponseMode, exampleId?: string) => {
		if (!request.id) return;
		updateRequest.mutate({
			id: request.id,
			mockResponseMode: next,
			mockExampleId: next === "fixed" ? (exampleId ?? examples[0]?.id) : null,
		});
	};

	return (
		<div className="flex flex-wrap items-center gap-2">
			{/*
			 * A `<span>`, not a `<Label>`: a segmented control is a group of
			 * buttons with no single labelable control to point `htmlFor` at, so
			 * the group carries its own `aria-label` instead (the shape
			 * `ModeElementForm.tsx`'s `ModePicker` uses).
			 */}
			<span className="text-xs font-medium">Mock response</span>
			<ToggleGroup
				value={mode}
				// Radix clears the value when the active segment is pressed again;
				// this mode always has to be something, never "off".
				onValueChange={(next) => next && setMode(next as MockResponseMode)}
				// `sm` (28px), not the default `xs` (24px): matches the 28px compact
				// `Select` this row shows in `fixed` mode, so switching into that
				// mode never changes the row's height (it does when the two
				// heights differ, because the row is `items-center` and grows to
				// its tallest child).
				size="sm"
				aria-label="Mock response"
			>
				<ToggleGroupItem value="first">First saved example</ToggleGroupItem>
				<ToggleGroupItem value="random">Random</ToggleGroupItem>
				<ToggleGroupItem value="fixed">Specific example</ToggleGroupItem>
			</ToggleGroup>
			{mode === "fixed" && (
				<Select
					value={request.mockExampleId ?? examples[0]?.id}
					onValueChange={(id) => setMode("fixed", id)}
				>
					{/* Fixed rem, not `w-40`: the trigger holds an example's name, a
					    text measure that should not narrow at the Default density the
					    way `w-40`'s `--spacing` unit does. */}
					<SelectTrigger className="h-control-sm w-[10rem] text-xs" aria-label="Example">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{examples.map((example) => (
							<SelectItem key={example.id} value={example.id}>
								{example.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
		</div>
	);
}

export default function ExamplesPanel() {
	const { request } = useRequestBuilderContext();
	const {
		data: examples,
		isLoading,
		error: loadError,
		refetch,
	} = useRequestExamplesQuery(request.id ?? null);
	const { data: savedRequest } = useRequestQuery(request.id ?? null);
	const { data: collections = [] } = useCollectionsQuery();
	const [pendingDelete, setPendingDelete] = useState<RequestExample | null>(null);
	const deleteExample = useDeleteRequestExampleMutation();
	const openImport = useImportModalStore((s) => s.open);
	const offerUndo = useTrashUndo();

	// The saved row, not the builder's draft: an unsaved rename would put a name
	// in the line that the engine and the agent's tools do not know yet.
	const exampleLine = useMemo(() => {
		if (!savedRequest) return null;
		const path = collectionNamePath(savedRequest.collectionId, collections);
		return (example: RequestExample) => exampleReference(example, savedRequest, path);
	}, [savedRequest, collections]);

	const confirmDelete = () => {
		if (!request.id || !pendingDelete) return;
		const { id, name, origin } = pendingDelete;
		deleteExample.mutate(
			{ requestId: request.id, exampleId: id },
			{
				onSuccess: () => {
					setPendingDelete(null);
					// An imported example is a spec-sync tombstone, not a Trash
					// entry: there is nothing to restore it from.
					if (origin !== "import") offerUndo(id, name, "example");
				},
			}
		);
	};

	// An unsaved request has no id, so there is nothing stored to list - said
	// plainly rather than shown as an empty list, which would read as "this
	// request has no examples" for a request that cannot have any yet.
	if (!request.id) {
		return (
			<EmptyState
				variant="inline"
				title="Save this request to see the example responses stored against it."
			/>
		);
	}
	if (isLoading) {
		return <DetailSkeleton label="Loading example responses" rows={3} className="p-0" />;
	}
	// Gated on no data: TanStack keeps the last list through a failed background
	// refetch, and a full-pane error over rows that are still valid would hide them.
	if (loadError && !examples) {
		return (
			<ErrorState
				title="Couldn't load example responses"
				detail={loadError.message}
				onRetry={() => void refetch()}
			/>
		);
	}
	if (!examples || examples.length === 0) {
		return (
			<EmptyState
				title="No example responses"
				description={
					<>
						Send this request and use{" "}
						<span className="font-medium">Save as example</span> to keep the response,
						or import a Postman collection with saved responses or an OpenAPI spec that
						documents them.
					</>
				}
				action={
					<Button variant="link" size="sm" onClick={openImport}>
						Import a collection
					</Button>
				}
			/>
		);
	}

	return (
		<div className="flex flex-col gap-2">
			{savedRequest && <MockResponseModeControl request={savedRequest} examples={examples} />}
			{examples.map((example) => (
				<ExampleRow
					key={example.id}
					example={example}
					reference={exampleLine ? exampleLine(example) : null}
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
			 * The last sentence differs by origin because what happens next does
			 * (issues #722, #2971). A saved example goes to the Trash and the
			 * toast after the delete offers it straight back. An imported one is
			 * not trashed - the engine keeps the delete as a tombstone, so no
			 * later sync writes it back - but re-importing the document is a
			 * fresh import and does bring it back, which is the one way it can
			 * return and so the one thing worth saying here.
			 */}
			<DeleteConfirmDialog
				open={!!pendingDelete}
				onOpenChange={(open) => !open && setPendingDelete(null)}
				title={`Delete "${pendingDelete?.name ?? "example"}"?`}
				confirmLabel="Delete example"
				description={exampleDeleteDescription(pendingDelete?.origin ?? "user")}
				// The engine's refusal, in the dialog that asked for the delete. Without
				// it a failed delete looks like nothing happened: the row is still there
				// and the dialog is still open.
				error={
					deleteExample.error && (
						<Callout severity="blocking">
							Couldn&apos;t delete the example: {deleteExample.error.message}
						</Callout>
					)
				}
				onConfirm={confirmDelete}
				isDeleting={deleteExample.isPending}
			/>
		</div>
	);
}
