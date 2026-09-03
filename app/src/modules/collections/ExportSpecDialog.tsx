/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ExportSpecDialog - a collection back out as an OpenAPI document (issue #630,
 * assembled engine-side since #855).
 *
 * The dialog exists because the export is not the same act in both directions,
 * and the user has to know which one they are about to perform *before* the file
 * lands in their downloads folder. A bound collection updates its own document;
 * a free-form one gets a skeleton, which is a starting point and not a contract.
 * Both statements are on screen, and so is everything the export could not
 * carry - a request with no operation identity, an operation removed because
 * nothing here claims it, an example whose media type nobody recorded.
 *
 * **The assembly is the engine's** (`POST /specs/export`). It used to be three
 * reads and ~900 lines here: the subtree's requests, every request's examples,
 * the stored document, then a parse and a patch on the render thread - seconds
 * of synchronous work on a 12MB spec, which #721 had to move off the render into
 * a scheduled task behind a pending line. All of that is one request now, and
 * what is left here is the choice, the summary and the download.
 *
 * Delivery is the repo's one file-to-disk path: a Blob and an `<a download>`,
 * the same shape `ResponseActions` uses. No IPC, no save dialog - there is no
 * such bridge, and the export does not need one.
 *
 * Mounted only while open, like `RunCollectionDialog`: the mount is the reset,
 * and the read costs nothing for a dialog nobody opened.
 *
 * **Nothing here is torn down to fetch something else** (issue #1311). The
 * summary states properties of the collection, not of the serialisation - the
 * counts are the same in JSON and YAML, and only the text and the file name
 * differ - so a format switch keeps the card and says it is working beside the
 * toggle, and the first read holds the card's footprint instead of collapsing
 * to a line. A dialog that centres on itself moves both of its edges for every
 * block that comes and goes.
 */

import { useState } from "react";
import { Copy, Download, FileJson, Loader2 } from "lucide-react";

import {
	Button,
	Dialog,
	DialogContent,
	DialogBody,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Skeleton,
	ToggleGroup,
	ToggleGroupItem,
} from "@/components/ui";
import { Callout } from "@/components/shared";
import { useCopy } from "@/hooks/useCopy";
import { useSpecExportQuery } from "@/queries/specs";
import type { Collection, ExportFormat, ExportNotes } from "@/types";

export interface ExportSpecDialogProps {
	/**
	 * The collection to export. Non-null: the caller mounts this only once a
	 * collection has been chosen and unmounts it on close, so the format choice
	 * starts at its default every time rather than carrying the last one over.
	 */
	collection: Collection;
	onOpenChange: (open: boolean) => void;
}

export default function ExportSpecDialog({ collection, onOpenChange }: ExportSpecDialogProps) {
	const [format, setFormat] = useState<ExportFormat>("json");
	const exported = useSpecExportQuery(collection.id, format);
	const copy = useCopy();

	const result = exported.data;
	/**
	 * One in-flight indicator at a time, and it never takes the card's place
	 * (issue #1311). The first read has nothing to keep on screen, so it holds
	 * the card's footprint; a format switch keeps the previous answer - the
	 * counts in it are the same either way - and says so beside the toggle
	 * instead. Both carry the same accessible name, so "is a document being
	 * assembled" is one question with one answer.
	 */
	const firstRead = exported.isPending;
	const reassembling = exported.isFetching && !firstRead;
	const handleDownload = () => {
		if (!result) return;
		const blob = new Blob([result.text], {
			type: format === "yaml" ? "application/yaml" : "application/json",
		});
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = result.fileName;
		anchor.click();
		URL.revokeObjectURL(url);
		onOpenChange(false);
	};

	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Export as OpenAPI</DialogTitle>
					<DialogDescription>
						{collection.name} as an OpenAPI document, assembled from what is stored -
						nothing is sent anywhere.
					</DialogDescription>
				</DialogHeader>

				<DialogBody className="space-y-3">
					<div className="flex items-center gap-3">
						<span className="text-xs text-muted-foreground">Format</span>
						<ToggleGroup
							value={format}
							// Radix clears the value when the active item is pressed
							// again; a format has no "off".
							onValueChange={(next) => next && setFormat(next as ExportFormat)}
							size="sm"
							aria-label="Export format"
						>
							<ToggleGroupItem value="json">JSON</ToggleGroupItem>
							<ToggleGroupItem value="yaml">YAML</ToggleGroupItem>
						</ToggleGroup>
						{/*
						 * A large spec spends real time being read and patched, and a
						 * dialog that showed nothing would read as one that had
						 * finished with nothing to say. Beside the toggle, because the
						 * toggle is what set it going and the card below stays where
						 * it is.
						 */}
						{reassembling && (
							<span
								role="status"
								aria-label="Assembling the document"
								className="text-muted-foreground"
							>
								<Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
							</span>
						)}
					</div>

					{firstRead && <SummarySkeleton />}

					{exported.error && (
						<Callout severity="blocking" title="The document could not be assembled">
							{errorText(exported.error)}
						</Callout>
					)}

					{result && <ExportSummary notes={result.notes} />}
				</DialogBody>

				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					{/*
					 * Disabled while a format assembles, not only while there is
					 * nothing: what is held is the *previous* format's text, and a
					 * click in that window would copy JSON out from under a YAML
					 * toggle. The window is one engine round trip.
					 */}
					<Button
						variant="outline"
						disabled={!result || reassembling}
						onClick={() => void copy(result?.text ?? "", "The document")}
					>
						<Copy className="mr-2 h-4 w-4" />
						Copy
					</Button>
					<Button disabled={!result || reassembling} onClick={handleDownload}>
						<Download className="mr-2 h-4 w-4" />
						Download
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Why there is no document.
 *
 * The engine's sentence, when it sent one: a bound document it could not read,
 * or a binding naming a spec that is not stored, are answers a user can act on -
 * they name the document and say what to do about it. Anything else is the
 * transport, and says so rather than being dressed up as a spec problem.
 */
function errorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message || "The engine did not answer.";
}

/**
 * `ExportSummary`'s footprint, held while the first read is in flight (issue
 * #1311).
 *
 * A placeholder in the summary's own box rather than a line of text, for the
 * reason `DetailSkeleton` and `ListSkeleton` give: a spinner says the app is
 * busy, this says what is about to appear, and it opens the dialog at roughly
 * the height it will keep. That matters more here than in a pane, because
 * `DialogContent` is centred on itself - a block appearing under the toggle
 * moves the top edge as well as the bottom, and the whole window reads as
 * flickering.
 *
 * Which direction ran is not known until the answer lands, and the two shapes
 * differ: a free-form collection's summary lists six counts, a bound one's
 * eight. Seven rows is the midpoint, so the card that arrives moves the
 * dialog's edge by at most one line in either direction rather than by two in
 * one of them. The paragraph above them is two bars because the sentence it
 * stands for wraps at this width in both directions.
 */
const PLACEHOLDER_ROWS = 7;

function SummarySkeleton() {
	return (
		<div
			className="rounded-md border border-rule surface-sunken p-3 space-y-2"
			role="status"
			aria-label="Assembling the document"
		>
			<div className="space-y-2" aria-hidden="true">
				<Skeleton className="h-4 w-2/3 rounded-md" />
				<Skeleton className="h-3 w-full rounded-md" />
				<Skeleton className="h-3 w-4/5 rounded-md" />
				<div className="space-y-1.5 pt-1">
					{Array.from({ length: PLACEHOLDER_ROWS }, (_, row) => (
						<Skeleton key={row} className="h-3 w-full rounded-md" />
					))}
				</div>
			</div>
		</div>
	);
}

/**
 * What the export is about to write, and what it could not carry.
 *
 * Every count is shown, zeros included - "0 requests with no operation" is how a
 * bound export states that it carried everything, and a summary that hid its
 * zeros would read as complete whether or not it was.
 */
function ExportSummary({ notes }: { notes: ExportNotes }) {
	const bound = notes.direction === "document";
	return (
		<div className="rounded-md border border-rule surface-sunken p-3 space-y-2">
			<p className="flex items-center gap-2 text-xs font-semibold">
				<FileJson className="h-3.5 w-3.5 text-primary shrink-0" />
				{bound ? "This collection's own document, updated" : "A skeleton document"}
				<span className="font-normal text-muted-foreground">({notes.dialect})</span>
			</p>
			<p className="text-[11px] text-muted-foreground">
				{bound
					? "Everything Vayu does not model - vendor extensions, unreferenced components, tags - is carried through untouched, and the dialect is left as it was."
					: "A starting point, not a contract: it describes the requests that are here, with no schema Vayu did not read off an example body."}
			</p>
			<ul className="text-[11px] text-muted-foreground space-y-0.5">
				<Line
					count={notes.requestsExported}
					label="request"
					suffix="exported as an operation"
				/>
				{bound ? (
					<>
						<Line
							count={notes.requestsWithoutOperation}
							label="request"
							suffix="with no operation identity - not written, bind the collection to give them one"
						/>
						<Line
							count={notes.operationsNotInDocument}
							label="request"
							suffix="naming an operation this document no longer declares - not written"
						/>
						<Line
							count={notes.operationsRemoved}
							label="operation"
							suffix="removed - nothing here claims it"
						/>
						<Line
							count={notes.sharedParametersLeft}
							label="shared $ref parameter"
							suffix="left as it is - it belongs to every operation that names it"
						/>
					</>
				) : (
					<>
						<Line
							count={notes.requestsWithoutPath}
							label="request"
							suffix="whose URL states no path - left out"
						/>
						<Line
							count={notes.duplicateOperations}
							label="request"
							suffix="on a method and path another request already claimed - left out"
						/>
					</>
				)}
				<Line
					count={notes.examplesWritten}
					label="example"
					suffix="written as a response"
				/>
				<Line
					count={notes.examplesWithoutMediaType}
					label="example"
					suffix="with no recorded media type - the response is written, the body is not"
				/>
				<Line
					count={notes.examplesTruncated}
					label="example"
					suffix="stored only in part - the response is written, the truncated body is not"
				/>
			</ul>
			{notes.vocabularyNotWritten && (
				<p className="text-[11px] text-muted-foreground">
					{notes.dialect} states parameters and examples in a vocabulary Vayu does not
					write. Operations nothing here claims are still removed, but nothing is written
					into the ones that stay.
				</p>
			)}
		</div>
	);
}

function Line({ count, label, suffix }: { count: number; label: string; suffix: string }) {
	return (
		<li>
			<span className="text-foreground">{count}</span> {label}
			{count === 1 ? "" : "s"} {suffix}
		</li>
	);
}
