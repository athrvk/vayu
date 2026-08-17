/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ExportSpecDialog - a collection back out as an OpenAPI document (issue #630).
 *
 * The dialog exists because the export is not the same act in both directions,
 * and the user has to know which one they are about to perform *before* the file
 * lands in their downloads folder. A bound collection updates its own document;
 * a free-form one gets a skeleton, which is a starting point and not a contract.
 * Both statements are on screen, and so is everything the export could not
 * carry - a request with no operation identity, an operation removed because
 * nothing here claims it, an example whose media type nobody recorded.
 *
 * Delivery is the repo's one file-to-disk path: a Blob and an `<a download>`,
 * the same shape `ResponseActions` uses. No IPC, no save dialog - there is no
 * such bridge, and the export does not need one.
 *
 * Mounted only while open, like `RunCollectionDialog`: the mount is the reset,
 * and the three reads the source hook makes cost nothing for a dialog nobody
 * opened.
 */

import { useMemo, useState } from "react";
import { Copy, Download, FileJson, Loader2 } from "lucide-react";

import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	ToggleGroup,
	ToggleGroupItem,
} from "@/components/ui";
import { Callout } from "@/components/shared";
import { useCopy } from "@/hooks/useCopy";
import {
	exportOpenApi,
	SpecDocumentError,
	type ExportFormat,
	type ExportNotes,
} from "@/services/exporters/openapi";
import type { Collection } from "@/types";
import { useOpenApiExportSource } from "./useOpenApiExportSource";

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
	const source = useOpenApiExportSource(collection);
	const copy = useCopy();

	const result = useMemo(() => {
		if (source.isLoading || source.specFailed) return null;
		try {
			return {
				value: exportOpenApi({
					collection,
					requests: source.requests,
					...(source.specContent === undefined
						? {}
						: { specContent: source.specContent }),
					format,
				}),
				error: null as string | null,
			};
		} catch (error) {
			// A stored document that cannot be read is refused rather than
			// quietly downgraded to a skeleton: a skeleton in place of the
			// document the user believes they are updating would drop every
			// member of their spec Vayu does not model.
			return {
				value: null,
				error:
					error instanceof SpecDocumentError
						? error.message
						: `The document could not be assembled: ${(error as Error).message}`,
			};
		}
	}, [
		collection,
		source.isLoading,
		source.specFailed,
		source.requests,
		source.specContent,
		format,
	]);

	const handleDownload = () => {
		if (!result?.value) return;
		const blob = new Blob([result.value.text], {
			type: format === "yaml" ? "application/yaml" : "application/json",
		});
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = result.value.fileName;
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

				<div className="space-y-3">
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
					</div>

					{source.isLoading && (
						<p className="flex items-center gap-2 text-xs text-muted-foreground">
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
							Reading the collection…
						</p>
					)}

					{source.specFailed && (
						<Callout severity="blocking" title="The bound document could not be read">
							This collection is bound to a spec the engine did not return, so there
							is nothing to update. Try again, or unbind it on the Spec tab to export
							a skeleton instead.
						</Callout>
					)}

					{result?.error && (
						<Callout severity="blocking" title="The document could not be updated">
							{result.error}
						</Callout>
					)}

					{result?.value && <ExportSummary notes={result.value.notes} />}
				</div>

				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						variant="outline"
						disabled={!result?.value}
						onClick={() => void copy(result?.value?.text ?? "", "The document")}
					>
						<Copy className="mr-2 h-4 w-4" />
						Copy
					</Button>
					<Button disabled={!result?.value} onClick={handleDownload}>
						<Download className="mr-2 h-4 w-4" />
						Download
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
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
