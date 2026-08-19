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
 *
 * **Assembly is not a render** (issue #721). Parsing a stored document, walking
 * it and serializing it is seconds of synchronous work on a 12MB spec, and it ran
 * in a `useMemo` - during render, again on every format toggle, with the window
 * frozen and nothing on screen to say why. It runs from an effect now, behind a
 * pending line, and each format's result is kept until the source changes so the
 * second toggle back is free.
 */

import { useEffect, useMemo, useState } from "react";
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
	type ExportRequest,
	type OpenApiExportInput,
	type OpenApiExportResult,
} from "@/services/exporters/openapi";
import type { Collection } from "@/types";
import { useOpenApiExportSource } from "./useOpenApiExportSource";

/** An assembled document, or why it could not be assembled. Never both. */
type Assembly = { value: OpenApiExportResult; error: null } | { value: null; error: string };

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

	// What has been assembled, and from which source. Held in state rather than
	// beside a "pending" flag, so that stale is *derived*: a result belongs to
	// one source key, and the moment the key moves it stops being the answer
	// without anyone having to remember to clear it.
	const [assembled, setAssembled] = useState<{
		key: string;
		byFormat: Partial<Record<ExportFormat, Assembly>>;
	}>({ key: "", byFormat: {} });

	const ready = !source.isLoading && !source.specFailed;
	const { requests, specContent } = source;
	const sourceKey = useMemo(() => describeSource(collection, requests), [collection, requests]);
	const result = (assembled.key === sourceKey ? assembled.byFormat[format] : undefined) ?? null;

	useEffect(() => {
		// Both early exits are the derivation above having answered already:
		// nothing to assemble yet, or this format assembled and kept - which is
		// what makes a toggle back to JSON free rather than a second parse.
		if (!ready || result) return;
		// A task, not a microtask: a microtask runs before the browser paints, so
		// the pending line below would never reach the screen and the window would
		// freeze exactly as it did from render.
		const scheduled = setTimeout(() => {
			const assembly = assemble({
				collection,
				requests,
				...(specContent === undefined ? {} : { specContent }),
				format,
			});
			setAssembled((previous) =>
				previous.key === sourceKey
					? { key: sourceKey, byFormat: { ...previous.byFormat, [format]: assembly } }
					: { key: sourceKey, byFormat: { [format]: assembly } }
			);
		}, 0);
		return () => clearTimeout(scheduled);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- `sourceKey` is the contents of `collection` and `requests`
	}, [ready, result, sourceKey, specContent, format]);

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
					</div>

					{source.isLoading && (
						<p className="flex items-center gap-2 text-xs text-muted-foreground">
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
							Reading the collection…
						</p>
					)}

					{/*
					 * The reads are in and the document is being put together. A
					 * large spec spends real time here, and a dialog that showed
					 * nothing would read as one that had finished with nothing to
					 * say.
					 */}
					{ready && !result && (
						<p className="flex items-center gap-2 text-xs text-muted-foreground">
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
							Assembling the document…
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
				</DialogBody>

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

/**
 * The export, or the sentence that says why there is none.
 *
 * A stored document that cannot be read is refused rather than quietly
 * downgraded to a skeleton: a skeleton in place of the document the user
 * believes they are updating would drop every member of their spec Vayu does
 * not model.
 */
function assemble(inputs: OpenApiExportInput): Assembly {
	try {
		return { value: exportOpenApi(inputs), error: null };
	} catch (error) {
		return {
			value: null,
			error:
				error instanceof SpecDocumentError
					? error.message
					: `The document could not be assembled: ${(error as Error).message}`,
		};
	}
}

/**
 * What the export would read, as a string that changes when it does.
 *
 * The rows themselves arrive as fresh arrays whenever a query re-runs, so
 * keying the assembly on their identity would re-parse the document for a
 * render that changed nothing. Timestamps carry the content: a request records
 * `updatedAt` on every edit, and an example row is read-only in the app - it
 * arrives with an import or a sync, both of which write new rows.
 *
 * `specContent` is not in here because it is a string, and a string is compared
 * by value in the effect's dependency list already.
 */
function describeSource(collection: Collection, requests: readonly ExportRequest[]): string {
	const rows = requests.map(
		(entry) =>
			`${entry.request.id}@${entry.request.updatedAt}+${entry.examples
				.map((example) => example.id)
				.join(".")}`
	);
	return `${collection.id}@${collection.updatedAt}|${rows.join(",")}`;
}

function Line({ count, label, suffix }: { count: number; label: string; suffix: string }) {
	return (
		<li>
			<span className="text-foreground">{count}</span> {label}
			{count === 1 ? "" : "s"} {suffix}
		</li>
	);
}
