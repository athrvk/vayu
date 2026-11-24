/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The request's saved example responses (#481, #588, #722): what an importer found beside the
 * request (Postman's saved responses, an OpenAPI operation's documented ones) and the responses a
 * user kept from the response viewer. Also what a mock server answers with, the first row of a
 * matched request being the one served, so the stored order is kept, never re-sorted here.
 *
 * Rows can be deleted, not edited: an example you can create and never remove is the #553 zombie
 * shape, and an editor is a separate change, so this is a viewer until then.
 *
 * **A row says where it came from, because the kinds behave differently** (#722). A spec sync
 * rewrites a request's imported examples whenever it changes the request, and never a saved one, so
 * which rows the next sync owns is shown. Deleting either kind is durable: an imported one becomes
 * an engine tombstone, a saved one goes to the Trash (#2971), which is why only a saved delete
 * offers Undo and why the dialog words what can bring the row back differently.
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
	TooltipIconButton,
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
 * The header map `ResponseBody` reads. Disabled rows are dropped and a repeated name keeps its last
 * value: it only picks a renderer and is not what the user sees; `ExampleRow` lists the stored
 * entries, duplicates visible.
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
			 * The expander and the delete cannot be one button, so the row is a container that
			 * paints the hover and the expander stretches into it, the drawer-row rule
			 * (`drawer-row-hit-area.test.tsx`): without `self-stretch` the padding above and below
			 * swallows clicks that look like they land on the row.
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
					 * A partial body, said on the row, not in the name (#659): the name is editable
					 * at save, so it lost the disclosure on any rename; the engine records
					 * `bodyTruncated`. Amber, not destructive: a truncated example is usable (a
					 * mock serves it, the response is real as far as it goes), so the state is
					 * "know this", never "broken", as `DATA_TOKEN_TONE_CLASS` reads `warning`.
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
					 * Where the row came from (#722): a sync rewrites the imported rows of a
					 * request it changes, never the saved ones, and without this nothing said which
					 * rows the next sync replaces. Neutral, unlike the amber beside it: provenance,
					 * not a warning. The muted text-only chip the settings cards use for such facts
					 * ("Every port", "Passphrase set"); `chip` paints no background, so the colour
					 * is the caller's to state.
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
				<TooltipIconButton
					variant="rowActionDestructive"
					onClick={onDelete}
					disabled={deleting}
					label={`Delete example ${example.name}`}
					tooltip="Delete example"
					className="shrink-0"
					icon={
						deleting ? (
							<Loader2 className="size-icon-sm animate-spin" />
						) : (
							<Trash2 className="size-icon-sm" />
						)
					}
				/>
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
						/>
					</div>
				</div>
			)}
		</div>
	);
}

/**
 * Which saved example a mock server answers with (#481 phase 3). A property of the request, not of
 * a running mock: an edit applies when a mock for this collection next starts, like any example
 * change. `mockResponseMode`/`mockExampleId` are on the persisted `Request`, written at once via
 * `useUpdateRequestMutation`, outside the dirty/save flow; `RequestState` never carries them, so
 * the caller passes the query-backed row.
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
	// What the mock answers with, not what the row records: an unset pointer, or one naming a gone
	// example (a sync can drop one without touching the request), falls back to the first, so the
	// selector shows it instead of a blank trigger (#3422).
	const effectiveExampleId = examples.some((e) => e.id === request.mockExampleId)
		? request.mockExampleId
		: examples[0]?.id;

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
			 * A `<span>`, not a `<Label>`: a segmented control has no single control for `htmlFor`,
			 * so the group carries its `aria-label` (as `ModeElementForm.tsx`'s `ModePicker` does).
			 */}
			<span className="text-xs font-medium">Mock response</span>
			<ToggleGroup
				value={mode}
				// Radix clears the value when the active segment is pressed again; this mode is
				// never "off".
				onValueChange={(next) => next && setMode(next as MockResponseMode)}
				// `sm` (28px), not the default `xs` (24px): it matches the 28px `Select` shown in
				// `fixed` mode, so switching modes never changes the `items-center` row's height.
				size="sm"
				aria-label="Mock response"
			>
				<ToggleGroupItem value="first">First saved example</ToggleGroupItem>
				<ToggleGroupItem value="random">Random</ToggleGroupItem>
				<ToggleGroupItem value="fixed">Specific example</ToggleGroupItem>
			</ToggleGroup>
			{mode === "fixed" && (
				<Select value={effectiveExampleId} onValueChange={(id) => setMode("fixed", id)}>
					{/*
					 * Fixed rem, not `w-40`: an example name is a text measure, which should not
					 * narrow at the Default density as `--spacing` does.
					 */}
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

	// The saved row, not the draft: the engine and the agent's tools do not know an unsaved rename.
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
					// An imported example becomes a spec-sync tombstone, not a Trash entry: nothing
					// to restore.
					if (origin !== "import") offerUndo(id, name, "example");
				},
			}
		);
	};

	// An unsaved request has nothing stored to list; said plainly, since an empty list would read
	// as "no examples" for a request that cannot have any yet.
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
	// Only with no data: TanStack keeps the last list through a failed refetch, and a full-pane
	// error would hide valid rows.
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
						// Clears the last refusal, so reopening does not lead with an old error.
						deleteExample.reset();
						setPendingDelete(example);
					}}
					deleting={deleteExample.isPending && pendingDelete?.id === example.id}
				/>
			))}

			{/*
			 * Confirmed, not immediate: a mock answers with a route's first example, so a delete
			 * can change what the next restart serves. The last sentence differs by origin (#722,
			 * #2971): a saved example goes to the Trash and the toast offers it back; an imported
			 * one becomes an engine tombstone, so no later sync writes it back, but re-importing
			 * the document does, the one way it returns and so the one thing worth saying.
			 */}
			<DeleteConfirmDialog
				open={!!pendingDelete}
				onOpenChange={(open) => !open && setPendingDelete(null)}
				title={`Delete "${pendingDelete?.name ?? "example"}"?`}
				confirmLabel="Delete example"
				description={exampleDeleteDescription(pendingDelete?.origin ?? "user")}
				// The engine's refusal, in the dialog that asked: without it a failed delete looks
				// like nothing happened, row present and dialog open.
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
