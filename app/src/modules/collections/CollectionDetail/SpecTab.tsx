/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * SpecTab - what OpenAPI document this collection answers to (issue #638,
 * phase 1b of #625).
 *
 * The problem it exists for: importing a spec produced requests and threw the
 * contract away. Nothing recorded which document the collection came from,
 * which version of it, or which operation each request was - so re-fetching a
 * changed spec meant importing it again beside the old copy, and a response
 * could not be checked against the schema that described it.
 *
 * Two halves, stored in two places, the same law the Data tab follows:
 *
 * - **The binding and the document** are collection state and ride the engine
 *   (`Collection.openapi` -> `spec_documents`), because they are the same on
 *   every machine and travel through import.
 * - **A picked file's path** is true of one filesystem only, so it lives in
 *   `spec-file-store` and never reaches the engine. A URL-sourced spec keeps its
 *   origin portably instead, in `spec_documents.source_url`.
 *
 * **Binding** deliberately creates and deletes nothing: it matches what is
 * already there and stamps identity on the matches - the operations with no
 * request, and the requests with no operation, are *reported* and left alone.
 * The one field it does rewrite is a request's own `specOperation`, and only to
 * clear one recorded against a **different** document (#718): after a bind, a
 * request's identity is the operation it matched here, or nothing. Unbinding
 * still leaves stamps exactly as they are, so unbind-then-bind-the-same-document
 * costs nothing - it is re-binding to a different one that would otherwise leave
 * a request claiming an operation of a document nothing is bound to.
 * **The bind itself is one engine call** (#862, `POST /specs/bind`): the
 * document, the binding and both halves of the stamping commit together, and
 * the pairing is worked out engine-side from the bytes it stores. So this tab
 * sends a document and a collection, and nothing it decided. The match query
 * below is the *preview* - it writes nothing, and is what the counts above the
 * Bind button are painted from.
 * The one place this tab writes *other* request fields is the Sync section, and
 * only for the items the user ticks: it re-reads the document and says what
 * moved (#654), and applies the selection in one engine transaction (#655).
 */

import { useMemo, useRef, useState } from "react";
import { Download, FileJson, Link2, Loader2, Trash2, Upload } from "lucide-react";

import { Button, Input, Skeleton } from "@/components/ui";
import { Callout } from "@/components/shared";
import { apiService } from "@/services/api";
import {
	useCollectionsQuery,
	useMultipleCollectionRequests,
	useUpdateCollectionMutation,
} from "@/queries/collections";
import { useBindSpecMutation, useSpecMatchQuery, useSpecMetaQuery } from "@/queries/specs";
import { useSpecDocumentLimit } from "@/hooks/useSpecDocumentLimit";
import { useSpecFileStore } from "@/stores";
import { readSpecOperations } from "@/services/openapi/spec-operations";
import SpecCoverageLine from "./SpecCoverageLine";
import { collectSubtreeIds } from "@/modules/collections/tree-utils";
import { formatBytes } from "@/modules/settings/utils/format-size";
import ExportSpecDialog from "@/modules/collections/ExportSpecDialog";
import { hasSpecBinding, type Collection } from "@/types";
import { formatRelative } from "./format";
import { InfoBanner, SaveFailed, SectionLabel } from "./shared";
import SpecSync from "./SpecSync";

interface SpecTabProps {
	collection: Collection;
}

/** A document the user has chosen but not yet bound. */
interface PickedSpec {
	content: string;
	/** The URL it was fetched from; absent for a file. */
	sourceUrl?: string;
	/** The file it was read from, and where that file is - absent for a URL. */
	fileName?: string;
	path?: string;
}

export default function SpecTab({ collection }: SpecTabProps) {
	const binding = collection.openapi;
	const bound = hasSpecBinding(binding);
	// The same condition as `bound`, in the form the Sync section needs: it reads
	// the document by id, and `hasSpecBinding` answers a question rather than
	// narrowing the field it asked about.
	const boundSpecId = binding?.specId;

	const { data: collections = [] } = useCollectionsQuery();
	/*
	 * The whole subtree, not this collection's own requests: an OpenAPI import
	 * files its requests under one sub-collection per tag, so a spec-bound root
	 * usually owns none directly. The binding covers everything beneath it, and
	 * so must the count that describes it.
	 */
	const subtreeIds = useMemo(
		() => collectSubtreeIds(collection.id, collections),
		[collection.id, collections]
	);
	const { requestsByCollection, isLoading: requestsLoading } =
		useMultipleCollectionRequests(subtreeIds);
	const requests = useMemo(
		() => [...requestsByCollection.values()].flat(),
		[requestsByCollection]
	);

	/*
	 * The card describes the document; it does not read it (issue #712). A first
	 * open used to transfer the whole stored spec - 12 MB for Stripe's - to paint
	 * a source line and a date, because both live on the document rather than on
	 * the collection's binding. The readers that genuinely need the text (export,
	 * and the Sync section's comparison) fetch it on the action that needs it.
	 */
	const {
		data: specMeta,
		isLoading: specLoading,
		isError: specFailed,
	} = useSpecMetaQuery(binding?.specId);
	const specFile = useSpecFileStore((s) => s.locations[collection.id]);
	const clearSpecFile = useSpecFileStore((s) => s.clearSpecFile);
	const setSpecFile = useSpecFileStore((s) => s.setSpecFile);

	const updateCollection = useUpdateCollectionMutation();
	const bindSpec = useBindSpecMutation();

	const [picked, setPicked] = useState<PickedSpec | null>(null);
	const [pickError, setPickError] = useState<string | null>(null);
	const [url, setUrl] = useState("");
	const [exporting, setExporting] = useState(false);
	const [fetching, setFetching] = useState(false);
	// The bound the fetch below carries: this tab only ever fetches a document
	// it is about to bind, so it is the same cap the engine will store it under
	// (issue #784).
	const { maxBytes: specMaxBytes } = useSpecDocumentLimit();
	const fileInputRef = useRef<HTMLInputElement>(null);

	// Parsed on every render of a picked document rather than stored in state:
	// the parse is pure and the alternative is two pieces of state that can
	// disagree about which document is on screen.
	const parsed = useMemo(() => {
		if (!picked) return null;
		try {
			return { ...readSpecOperations(picked.content), error: null as string | null };
		} catch (e) {
			return {
				operations: [],
				format: "",
				title: "",
				error: (e as Error).message,
			};
		}
	}, [picked]);

	/*
	 * The pairing is the engine's answer now (issue #761): the rule that decides
	 * which request is which operation moved into `core/operation_match.hpp`, so
	 * that binding a collection is something an agent over MCP can do the same
	 * way rather than through a second copy of it. Nothing is written by asking -
	 * the counts below still appear before the user commits to the bind.
	 */
	const matchQuery = useSpecMatchQuery(
		collection.id,
		requests,
		parsed && !parsed.error ? parsed.operations : null
	);
	const match = matchQuery.data ?? null;

	const mappedCount = requests.filter((r) => r.specOperation).length;

	/*
	 * Requests carrying identity the document about to be bound does not account
	 * for (issue #718). Binding is the only moment the app can tell: unbinding
	 * deliberately leaves stamps alone - so unbind-then-bind-the-same-document is
	 * lossless - and it is re-binding to a *different* one that would otherwise
	 * leave a request stamped as an operation of a document this collection is
	 * no longer bound to. Coverage resolves stamps by `operationId` first, so
	 * such a stamp does not merely go unread; it claims whatever operation of the
	 * new document happens to share the id.
	 */
	const staleStamps = useMemo(() => {
		if (!match) return [];
		// The engine answers in ids; which of them *carry* a stamp is read off the
		// request rows this tab already holds, rather than asked for a second time.
		const stamped = new Set(requests.filter((r) => r.specOperation).map((r) => r.id));
		return match.unmatchedRequests.filter((id) => stamped.has(id));
	}, [match, requests]);

	const handleFile = (file: File) => {
		const reader = new FileReader();
		reader.onload = () => {
			setPickError(null);
			setPicked({
				content: String(reader.result),
				fileName: file.name,
				// The path while there is still a `File` to take it from - see
				// `spec-file-store` for why only the path is kept.
				path: window.electronAPI?.getFilePath(file) ?? "",
			});
		};
		reader.onerror = () => setPickError("Could not read that file.");
		reader.readAsText(file);
	};

	const handleFetch = async () => {
		if (!url || fetching) return;
		setFetching(true);
		setPickError(null);
		try {
			const { content } = await apiService.importFetch(url, specMaxBytes);
			setPicked({ content, sourceUrl: url });
		} catch (e) {
			setPickError((e as Error).message);
		} finally {
			setFetching(false);
		}
	};

	const handleBind = () => {
		if (!picked || !match || parsed?.error) return;
		// The document and the collection, and nothing else: the engine works
		// the pairing out from the bytes it stores and stamps both halves of it
		// in one transaction (issue #862). What `match` gave us above is the
		// preview the summary is painted from, not a payload.
		bindSpec.mutate(
			{
				collectionId: collection.id,
				content: picked.content,
				sourceUrl: picked.sourceUrl ?? null,
			},
			{
				onSuccess: () => {
					// Remembered only after the binding is stored, for the reason
					// the Data tab remembers a data file only after the contract:
					// a path for a collection that is bound to nothing points at a
					// document nothing can be compared against.
					if (picked.path && picked.fileName) {
						setSpecFile(collection.id, {
							path: picked.path,
							fileName: picked.fileName,
						});
					} else {
						clearSpecFile(collection.id);
					}
					setPicked(null);
					setUrl("");
				},
			}
		);
	};

	const handleUnbind = () => {
		// `null`, not `{}`: the engine reads absent as "keep" and null as "reset
		// to the default", and the default is unbound. The document itself stays -
		// another collection may bind it, and deleting one out from under a
		// binding is what the engine refuses.
		updateCollection.mutate(
			{ id: collection.id, openapi: null },
			{ onSuccess: () => clearSpecFile(collection.id) }
		);
	};

	return (
		<div className="max-w-[720px] flex flex-col gap-4">
			<InfoBanner>
				Bind this collection to an OpenAPI document so Vayu knows which operation each
				request is. The document is stored with the collection; a file picked from this
				machine is remembered by path only, and its contents are never copied into local
				storage.
			</InfoBanner>

			{bound ? (
				<BoundSpec
					sourceUrl={specMeta?.sourceUrl ?? null}
					fileName={specFile?.fileName}
					specHash={binding?.specHash}
					fetchedAt={specMeta?.fetchedAt}
					contentBytes={specMeta?.contentBytes}
					syncedAt={binding?.syncedAt}
					loading={specLoading}
					requestsLoading={requestsLoading}
					failed={specFailed}
					mappedCount={mappedCount}
					requestCount={requests.length}
				/>
			) : (
				<div>
					<SectionLabel>No spec bound</SectionLabel>
					<p className="text-xs text-muted-foreground">
						Pick a document below. Vayu matches its operations to the requests already
						here by method and path, and records the identity of the ones that match -
						nothing is created or deleted. The only thing rewritten is identity recorded
						against a different document, which is cleared.
					</p>
				</div>
			)}

			{!bound && (
				<div className="rounded-md border border-rule bg-card surface-card p-3 space-y-3">
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							onClick={() => fileInputRef.current?.click()}
							disabled={bindSpec.isPending}
						>
							<Upload className="mr-2 h-4 w-4" />
							Choose file
						</Button>
						<input
							ref={fileInputRef}
							type="file"
							className="hidden"
							accept=".json,.yaml,.yml"
							aria-label="OpenAPI document"
							onChange={(e) => {
								const file = e.target.files?.[0];
								// The same value twice is not a change event, so
								// clearing lets the user re-pick what they just picked.
								e.target.value = "";
								if (file) handleFile(file);
							}}
						/>
						<span className="text-[11px] text-muted-foreground">or</span>
						<Input
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") void handleFetch();
							}}
							placeholder="https://api.example.com/openapi.json"
							className="flex-1"
							disabled={fetching || bindSpec.isPending}
						/>
						<Button
							variant="outline"
							onClick={() => void handleFetch()}
							disabled={!url || fetching || bindSpec.isPending}
						>
							{fetching ? (
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							) : (
								<Link2 className="mr-2 h-4 w-4" />
							)}
							Fetch
						</Button>
					</div>

					{pickError && (
						<Callout severity="blocking" title="Couldn't read that document">
							{pickError}
						</Callout>
					)}

					{parsed?.error && (
						<Callout severity="blocking" title="Not an OpenAPI document">
							{parsed.error}
						</Callout>
					)}

					{/* The pairing is an engine read now (issue #761), so it has the two
					    states a computation did not: still arriving, and failed. A
					    failure blocks the bind rather than falling back to a local
					    match - a bind stamps identity, and identity worked out by a
					    second implementation is the thing this move exists to end. */}
					{/* `isFetching`, not `isPending`: a disabled query - nothing picked,
					    or a document that did not parse - is pending forever. */}
					{matchQuery.isFetching && (
						<p className="flex items-center gap-2 text-xs text-muted-foreground">
							<Loader2 className="h-3 w-3 animate-spin" />
							Matching this document against the requests here...
						</p>
					)}

					{matchQuery.isError && (
						<Callout severity="blocking" title="Couldn't match that document">
							{(matchQuery.error as Error).message}
						</Callout>
					)}

					{picked && match && parsed && !parsed.error && (
						<MatchSummary
							title={parsed.title}
							format={parsed.format}
							source={picked.sourceUrl ?? picked.fileName ?? "the picked document"}
							matched={match.matched.length}
							unmatchedRequests={match.unmatchedRequests.length}
							unmatchedOperations={match.unmatchedOperations.length}
							staleStamps={staleStamps.length}
						/>
					)}

					{picked && match && !parsed?.error && (
						<Button onClick={handleBind} disabled={bindSpec.isPending}>
							{bindSpec.isPending ? (
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							) : (
								<FileJson className="mr-2 h-4 w-4" />
							)}
							Bind this spec
						</Button>
					)}
				</div>
			)}

			{bound && <SpecCoverageLine collectionId={collection.id} />}

			{boundSpecId && (
				<SpecSync
					collection={collection}
					collections={collections}
					// The binding's id, not the document: the section reads the stored
					// bytes itself, when Check is pressed (issue #712).
					specId={boundSpecId}
					specFile={specFile}
					requests={requests}
				/>
			)}

			<SaveFailed mutation={bindSpec} what="the spec binding" />
			<SaveFailed mutation={updateCollection} what="the spec binding" />

			{bound && (
				<div>
					<SectionLabel>Export</SectionLabel>
					<Button variant="outline" onClick={() => setExporting(true)}>
						<Download className="mr-2 h-4 w-4" />
						Export as OpenAPI
					</Button>
					<p className="mt-1 text-[11px] text-muted-foreground">
						Writes this collection's own document back out, updated: operations it no
						longer has removed, stored examples written in, and everything Vayu does not
						model left exactly as it is.
					</p>
				</div>
			)}

			{bound && (
				<div>
					<Button
						variant="outline"
						onClick={handleUnbind}
						disabled={updateCollection.isPending}
					>
						<Trash2 className="mr-2 h-4 w-4" />
						Unbind
					</Button>
					<p className="mt-1 text-[11px] text-muted-foreground">
						Unbinding leaves the requests and their recorded operations exactly as they
						are, and leaves the stored document for anything else bound to it.
					</p>
				</div>
			)}

			{/* Mounted only while open, the way the tree mounts it: the same dialog
			    the collection's ⋯ menu opens, so there is one export flow and not
			    two that can disagree. */}
			{exporting && (
				<ExportSpecDialog
					collection={collection}
					onOpenChange={(open) => !open && setExporting(false)}
				/>
			)}
		</div>
	);
}

function BoundSpec({
	sourceUrl,
	fileName,
	specHash,
	fetchedAt,
	contentBytes,
	syncedAt,
	loading,
	requestsLoading,
	failed,
	mappedCount,
	requestCount,
}: {
	sourceUrl: string | null;
	fileName: string | undefined;
	specHash: string | undefined;
	fetchedAt: number | undefined;
	contentBytes: number | undefined;
	syncedAt: number | undefined;
	/** The document's own description is still in flight. */
	loading: boolean;
	/** The subtree's request lists are still in flight - the mapped count's input. */
	requestsLoading: boolean;
	failed: boolean;
	mappedCount: number;
	requestCount: number;
}) {
	/*
	 * Three sources, three different truths, and the order matters. A URL is
	 * portable and is what a re-fetch will use. A file name is machine-local and
	 * only known if this machine is the one that picked it. Neither means the
	 * document was pasted - so the third line says where it came from as
	 * precisely as it can rather than inventing a filename.
	 *
	 * It is the *settled* answer, and only that (issue #712). While the document
	 * is being described, all three are unknown, and rendering the fallback then
	 * is not a blank - it is a false statement: a URL-imported spec would claim
	 * to have come from nowhere in particular right up until the read lands. So
	 * a pending card renders a skeleton here, never this string.
	 */
	const source = sourceUrl ?? fileName ?? "a document stored with this collection";

	return (
		<div>
			<SectionLabel>Bound spec</SectionLabel>
			<div className="rounded-md border border-rule bg-card surface-card p-3 space-y-2">
				<div className="flex items-center gap-2 text-xs">
					{/* The icon is part of the claim - a link icon beside a skeleton would
					    already be saying the document came from a URL. */}
					{loading ? (
						<Skeleton data-testid="spec-source-skeleton" className="h-4 w-64" />
					) : (
						<>
							{sourceUrl ? (
								<Link2 className="h-3.5 w-3.5 text-primary shrink-0" />
							) : (
								<FileJson className="h-3.5 w-3.5 text-primary shrink-0" />
							)}
							<span className="font-mono break-all">{source}</span>
						</>
					)}
				</div>
				{/*
				 * A cell is a skeleton while *its own* input is unknown, rather than the
				 * grid going blank as a block: Hash and Bound are read off the
				 * collection's binding, which this tab has before it renders, and
				 * hiding a value that is already known would be a second way of
				 * describing the document wrongly.
				 */}
				<dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
					<div className="flex gap-1.5">
						<dt>Hash</dt>
						<dd className="font-mono text-foreground">{shortHash(specHash)}</dd>
					</div>
					<div className="flex gap-1.5">
						<dt>Operations mapped</dt>
						<dd className="text-foreground">
							{requestsLoading ? (
								<Skeleton data-testid="spec-mapped-skeleton" className="h-3 w-28" />
							) : (
								<>
									{mappedCount} of {requestCount} request
									{requestCount === 1 ? "" : "s"}
								</>
							)}
						</dd>
					</div>
					<div className="flex gap-1.5">
						<dt>Fetched</dt>
						<dd className="text-foreground">
							{loading ? (
								<Skeleton
									data-testid="spec-fetched-skeleton"
									className="h-3 w-20"
								/>
							) : (
								formatRelative(epochToIso(fetchedAt))
							)}
						</dd>
					</div>
					<div className="flex gap-1.5">
						<dt>Bound</dt>
						<dd className="text-foreground">{formatRelative(epochToIso(syncedAt))}</dd>
					</div>
					<div className="flex gap-1.5">
						<dt>Size</dt>
						<dd className="text-foreground">
							{loading ? (
								<Skeleton data-testid="spec-size-skeleton" className="h-3 w-16" />
							) : (
								formatDocumentSize(contentBytes)
							)}
						</dd>
					</div>
				</dl>
				{failed && (
					<p className="text-[11px] text-destructive-text">
						The stored document could not be read - its source and fetch time are
						unknown until the engine answers.
					</p>
				)}
			</div>
		</div>
	);
}

function MatchSummary({
	title,
	format,
	source,
	matched,
	unmatchedRequests,
	unmatchedOperations,
	staleStamps,
}: {
	title: string;
	format: string;
	source: string;
	matched: number;
	unmatchedRequests: number;
	unmatchedOperations: number;
	staleStamps: number;
}) {
	return (
		<div className="rounded-md border border-rule surface-sunken p-3 space-y-1">
			<p className="text-xs font-semibold">
				{title || "Untitled API"}{" "}
				<span className="font-normal text-muted-foreground">({format})</span>
			</p>
			<p className="text-[11px] text-muted-foreground break-all">from {source}</p>
			{/*
			 * All three numbers, always - including the zeros. "matched 12" alone
			 * reads as a complete result; "matched 12, 3 requests unmatched, 4
			 * operations with no request" is what the user is actually agreeing to,
			 * and the two leftovers are what sync (#627) will later offer to act on.
			 */}
			<p className="text-[11px] text-muted-foreground">
				Matched {matched} request{matched === 1 ? "" : "s"} · {unmatchedRequests} request
				{unmatchedRequests === 1 ? "" : "s"} with no operation · {unmatchedOperations}{" "}
				operation
				{unmatchedOperations === 1 ? "" : "s"} with no request
			</p>
			{/*
			 * The one line here that describes a *write* to something that already
			 * exists, so it is stated separately and only when it applies. Nothing
			 * else about a bind touches a request that did not match; this does,
			 * and the user is agreeing to it (issue #718).
			 */}
			{staleStamps > 0 && (
				<p className="text-[11px] text-muted-foreground">
					{staleStamps} request{staleStamps === 1 ? "" : "s"} record
					{staleStamps === 1 ? "s" : ""} an operation this document does not have - that
					identity is cleared, because it names another document.
				</p>
			)}
		</div>
	);
}

/**
 * The document's size, or `-` for a card whose description could not be read.
 *
 * Through the settings formatter rather than a second rounding of the same
 * number: the size shown here and the `maxSpecDocumentBytes` limit shown in
 * Settings are the same quantity, and two spellings of "1.5 MB" would be one
 * more thing to keep in step.
 */
function formatDocumentSize(bytes: number | undefined): string {
	return bytes === undefined ? "-" : formatBytes(bytes);
}

/** The first 12 hex characters - enough to compare two by eye, and it fits. */
function shortHash(hash: string | undefined): string {
	if (!hash) return "-";
	return hash.length > 12 ? hash.slice(0, 12) : hash;
}

function epochToIso(epochMs: number | undefined): string | undefined {
	return epochMs === undefined ? undefined : new Date(epochMs).toISOString();
}
