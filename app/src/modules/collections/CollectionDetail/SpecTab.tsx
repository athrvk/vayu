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
 * What this tab deliberately does not do: create, delete or edit requests.
 * Binding an existing collection matches what is already there and stamps
 * identity on the matches - the operations with no request, and the requests
 * with no operation, are *reported* and left alone. The Sync section (#654)
 * holds to the same line: it re-reads the document and says what moved, and
 * acting on that difference is #655.
 */

import { useMemo, useRef, useState } from "react";
import { FileJson, Link2, Loader2, Trash2, Upload } from "lucide-react";

import { Button, Input } from "@/components/ui";
import { Callout } from "@/components/shared";
import { apiService } from "@/services/api";
import {
	useCollectionsQuery,
	useMultipleCollectionRequests,
	useUpdateCollectionMutation,
} from "@/queries/collections";
import { useBindSpecMutation, useSpecQuery } from "@/queries/specs";
import { useSpecFileStore } from "@/stores";
import { matchOperations } from "@/services/openapi/operation-match";
import { readSpecOperations } from "@/services/openapi/spec-operations";
import { collectSubtreeIds } from "@/modules/collections/tree-utils";
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
	const { requestsByCollection } = useMultipleCollectionRequests(subtreeIds);
	const requests = useMemo(
		() => [...requestsByCollection.values()].flat(),
		[requestsByCollection]
	);

	const {
		data: spec,
		isLoading: specLoading,
		isError: specFailed,
	} = useSpecQuery(binding?.specId);
	const specFile = useSpecFileStore((s) => s.locations[collection.id]);
	const clearSpecFile = useSpecFileStore((s) => s.clearSpecFile);
	const setSpecFile = useSpecFileStore((s) => s.setSpecFile);

	const updateCollection = useUpdateCollectionMutation();
	const bindSpec = useBindSpecMutation();

	const [picked, setPicked] = useState<PickedSpec | null>(null);
	const [pickError, setPickError] = useState<string | null>(null);
	const [url, setUrl] = useState("");
	const [fetching, setFetching] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// Parsed on every render of a picked document rather than stored in state:
	// the parse is pure and the alternative is two pieces of state that can
	// disagree about which document is on screen.
	const parsed = useMemo(() => {
		if (!picked) return null;
		try {
			return { ...readSpecOperations(picked.content), error: null as string | null };
		} catch (e) {
			return { operations: [], format: "", title: "", error: (e as Error).message };
		}
	}, [picked]);

	const match = useMemo(
		() => (parsed && !parsed.error ? matchOperations(requests, parsed.operations) : null),
		[parsed, requests]
	);

	const mappedCount = requests.filter((r) => r.specOperation).length;

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
			const { content } = await apiService.importFetch(url);
			setPicked({ content, sourceUrl: url });
		} catch (e) {
			setPickError((e as Error).message);
		} finally {
			setFetching(false);
		}
	};

	const handleBind = () => {
		if (!picked || !match || parsed?.error) return;
		bindSpec.mutate(
			{
				collectionId: collection.id,
				content: picked.content,
				sourceUrl: picked.sourceUrl ?? null,
				stamps: match.matched.map(({ request, operation }) => ({
					requestId: request.id,
					specOperation: operation,
				})),
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
					sourceUrl={spec?.sourceUrl ?? null}
					fileName={specFile?.fileName}
					specHash={binding?.specHash}
					fetchedAt={spec?.fetchedAt}
					syncedAt={binding?.syncedAt}
					loading={specLoading}
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
						nothing is created, deleted or rewritten.
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

					{picked && match && parsed && !parsed.error && (
						<MatchSummary
							title={parsed.title}
							format={parsed.format}
							source={picked.sourceUrl ?? picked.fileName ?? "the picked document"}
							matched={match.matched.length}
							unmatchedRequests={match.unmatchedRequests.length}
							unmatchedOperations={match.unmatchedOperations.length}
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

			{bound && <SpecSync spec={spec} specFile={specFile} requests={requests} />}

			<SaveFailed mutation={bindSpec} what="the spec binding" />
			<SaveFailed mutation={updateCollection} what="the spec binding" />

			{bindSpec.data && bindSpec.data.failedStamps.length > 0 && (
				<Callout severity="warning" title="Bound, but some requests were not stamped">
					{bindSpec.data.failedStamps.length} request
					{bindSpec.data.failedStamps.length === 1 ? "" : "s"} kept no operation identity.
					Bind again to retry those.
				</Callout>
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
		</div>
	);
}

function BoundSpec({
	sourceUrl,
	fileName,
	specHash,
	fetchedAt,
	syncedAt,
	loading,
	failed,
	mappedCount,
	requestCount,
}: {
	sourceUrl: string | null;
	fileName: string | undefined;
	specHash: string | undefined;
	fetchedAt: number | undefined;
	syncedAt: number | undefined;
	loading: boolean;
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
	 */
	const source = sourceUrl ?? fileName ?? "a document stored with this collection";

	return (
		<div>
			<SectionLabel>Bound spec</SectionLabel>
			<div className="rounded-md border border-rule bg-card surface-card p-3 space-y-2">
				<div className="flex items-center gap-2 text-xs">
					{sourceUrl ? (
						<Link2 className="h-3.5 w-3.5 text-primary shrink-0" />
					) : (
						<FileJson className="h-3.5 w-3.5 text-primary shrink-0" />
					)}
					<span className="font-mono break-all">{source}</span>
				</div>
				<dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
					<div className="flex gap-1.5">
						<dt>Hash</dt>
						<dd className="font-mono text-foreground">{shortHash(specHash)}</dd>
					</div>
					<div className="flex gap-1.5">
						<dt>Operations mapped</dt>
						<dd className="text-foreground">
							{mappedCount} of {requestCount} request{requestCount === 1 ? "" : "s"}
						</dd>
					</div>
					<div className="flex gap-1.5">
						<dt>Fetched</dt>
						<dd className="text-foreground">
							{loading ? "…" : formatRelative(epochToIso(fetchedAt))}
						</dd>
					</div>
					<div className="flex gap-1.5">
						<dt>Bound</dt>
						<dd className="text-foreground">{formatRelative(epochToIso(syncedAt))}</dd>
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
}: {
	title: string;
	format: string;
	source: string;
	matched: number;
	unmatchedRequests: number;
	unmatchedOperations: number;
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
		</div>
	);
}

/** The first 12 hex characters - enough to compare two by eye, and it fits. */
function shortHash(hash: string | undefined): string {
	if (!hash) return "-";
	return hash.length > 12 ? hash.slice(0, 12) : hash;
}

function epochToIso(epochMs: number | undefined): string | undefined {
	return epochMs === undefined ? undefined : new Date(epochMs).toISOString();
}
