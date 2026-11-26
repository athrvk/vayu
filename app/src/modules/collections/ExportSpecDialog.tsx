/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A collection back out as an OpenAPI document (issue #630, assembled engine-side, #855).
 *
 * The dialog exists because the export is not the same act in both directions, and the user must
 * know which one they are performing *before* the file lands in their downloads folder. A bound
 * collection updates its own document; a free-form one gets a skeleton, a starting point and not a
 * contract. Both are stated on screen, with what the export could not carry that a user would miss
 * (a new request left out, a secret written empty).
 *
 * **The assembly is the engine's** (`POST /specs/export`): here it would be seconds of synchronous
 * render-thread work for a 12MB spec (#721). What is left here is the choice, the summary and the
 * download. Delivery is the repo's one file-to-disk path, `downloadTextFile` (as in
 * `ResponseActions`), which reports what became of the file (#3246): the dialog closes once it is
 * written, stays open on a cancelled save dialog, and says why a write failed.
 *
 * **A bound collection also asks how much to write.** Its document is usually somebody's contract,
 * so the default, "Values only", writes examples and parameter values and leaves its structure
 * alone; "All edits" writes every edit the collection holds into it, new requests included. A
 * free-form collection has no contract to keep and is not asked.
 *
 * Mounted only while open, like `RunCollectionDialog`: the mount is the reset, and a dialog nobody
 * opened reads nothing.
 *
 * **Nothing is torn down to fetch something else** (issue #1311). The summary states properties of
 * the collection, not of the serialisation (JSON and YAML share the counts; only the text and the
 * file name differ), so a format switch keeps the card and shows its work beside the toggle, and
 * the first read holds the card's footprint instead of collapsing to a line. A dialog centred on
 * itself moves both edges for every block that comes and goes.
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
	DialogCancelButton,
	ICON_MOTION,
} from "@/components/ui";
import { Callout } from "@/components/shared";
import { useCopy } from "@/hooks/useCopy";
import { ENGINE_NO_ANSWER } from "@/lib/engine-error-text";
import { downloadTextFile } from "@/lib/download-text-file";
import { useSpecExportQuery } from "@/queries/specs";
import type { Collection, ExportFormat, ExportMode, ExportNotes } from "@/types";
import { pluralize } from "@/modules/dashboard/utils/format";

export interface ExportSpecDialogProps {
	/**
	 * The collection to export. Non-null: the caller mounts this only once a
	 * collection has been chosen and unmounts it on close, so the format choice
	 * starts at its default every time rather than carrying the last one over.
	 */
	collection: Collection;
	onOpenChange: (open: boolean) => void;
	/**
	 * Where focus goes on close. Radix restores it to whatever held it before the dialog opened,
	 * which for a dialog opened from a row's menu is a menu item that is gone, so focus lands on
	 * `<body>` (#3443). A caller that knows the row calls `preventDefault` and focuses it.
	 */
	onCloseAutoFocus?: (event: Event) => void;
}

export default function ExportSpecDialog({
	collection,
	onOpenChange,
	onCloseAutoFocus,
}: ExportSpecDialogProps) {
	const [format, setFormat] = useState<ExportFormat>("json");
	const [mode, setMode] = useState<ExportMode>("contract");
	const [saveError, setSaveError] = useState<string | null>(null);
	// The binding decides the direction, so it decides whether there is a
	// contract to keep - the engine reads the same fact off the same row.
	const bound = Boolean(collection.openapi?.specId);
	const exported = useSpecExportQuery(collection.id, format, mode);
	const { copy } = useCopy();

	const result = exported.data;
	/**
	 * One in-flight indicator at a time, never in the card's place (issue #1311). The first read
	 * has nothing to keep, so it holds the card's footprint; a format switch keeps the previous
	 * answer (its counts are the same either way) and says so beside the toggle. Both carry the
	 * same accessible name, so "is a document being assembled" is one question with one answer.
	 */
	const firstRead = exported.isPending;
	const reassembling = exported.isFetching && !firstRead;
	const handleDownload = async () => {
		if (!result) return;
		setSaveError(null);
		const saved = await downloadTextFile(
			result.text,
			result.fileName,
			format === "yaml" ? "application/yaml" : "application/json"
		);
		if (saved.outcome === "saved") onOpenChange(false);
		if (saved.outcome === "failed") setSaveError(saved.message);
	};

	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-xl" onCloseAutoFocus={onCloseAutoFocus}>
				<DialogHeader>
					<DialogTitle>Export as OpenAPI</DialogTitle>
					<DialogDescription>
						Save {collection.name} as an OpenAPI file. Nothing leaves your machine.
					</DialogDescription>
				</DialogHeader>

				<DialogBody className="space-y-3">
					<div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-3">
						<span className="text-xs text-muted-foreground">Format</span>
						<div className="flex items-center gap-3">
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
							 * A large spec spends real time being read and patched, and a blank
							 * would read as finished with nothing to say. Beside the toggle, which
							 * set it going, while the card below stays put.
							 */}
							{reassembling && (
								<span
									role="status"
									aria-label="Assembling the document"
									className="text-muted-foreground"
								>
									<Loader2
										className="size-icon-sm animate-spin"
										aria-hidden="true"
									/>
								</span>
							)}
						</div>
						{bound && (
							<>
								<span className="text-xs text-muted-foreground">Changes</span>
								<ToggleGroup
									value={mode}
									// A mode has no "off" either.
									onValueChange={(next) => next && setMode(next as ExportMode)}
									size="sm"
									aria-label="Changes to write"
									className="justify-self-start"
								>
									<ToggleGroupItem value="contract">Values only</ToggleGroupItem>
									<ToggleGroupItem value="full">All edits</ToggleGroupItem>
								</ToggleGroup>
								<p className="col-start-2 -mt-2 text-label text-muted-foreground">
									{mode === "full"
										? "Writes every change made in Vayu, new requests included."
										: "Updates values and examples; operations no request here claims are removed."}
								</p>
							</>
						)}
					</div>

					{firstRead && <SummarySkeleton />}

					{exported.error && (
						<Callout severity="blocking" title="Couldn't assemble the document">
							{errorText(exported.error)}
						</Callout>
					)}

					{result && <ExportSummary notes={result.notes} />}

					{saveError && (
						<Callout severity="blocking" title="Couldn't save the file">
							{saveError}
						</Callout>
					)}
				</DialogBody>

				<DialogFooter>
					<DialogCancelButton onClick={() => onOpenChange(false)} />
					{/*
					 * Disabled while a format assembles, not only while empty: the held text is the
					 * *previous* format's, so a click in that window (one engine round trip) would
					 * copy JSON under a YAML toggle.
					 */}
					<Button
						variant="outline"
						disabled={!result || reassembling}
						onClick={() => void copy(result?.text ?? "", "The document")}
					>
						<Copy className="size-icon" />
						Copy
					</Button>
					<Button
						disabled={!result || reassembling}
						onClick={() => void handleDownload()}
					>
						<Download className="size-icon" data-icon-motion={ICON_MOTION.drop} />
						Download
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Why there is no document: the engine's sentence when it sent one (a bound document it could not
 * read, a binding naming a spec that is not stored), which names the document and the remedy; else
 * the transport's, said as such rather than dressed up as a spec problem.
 */
function errorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message || ENGINE_NO_ANSWER;
}

/**
 * `ExportSummary`'s footprint, held while the first read is in flight (issue #1311). A placeholder
 * in the summary's own box, not a line of text, for `DetailSkeleton`'s and `ListSkeleton`'s reason
 * (a spinner says the app is busy, this says what is about to appear), and it opens the dialog at
 * about the height it keeps. That matters more here than in a pane: `DialogContent` is centred on
 * itself, so a block appearing under the toggle moves the top edge as well as the bottom.
 *
 * The summary lists only non-zero counts, so its height varies; the placeholder holds a typical
 * answer (a heading, a sentence and a few lines), not the longest, which almost no export reaches.
 */
const PLACEHOLDER_ROWS = 4;

function SummarySkeleton() {
	return (
		<div
			className="rounded-md border border-rule surface-sunken p-3 space-y-2"
			role="status"
			aria-label="Assembling the document"
		>
			<div className="space-y-2" aria-hidden="true">
				<Skeleton className="h-4 w-2/3 rounded-md" />
				<Skeleton className="h-3 w-4/5 rounded-md" />
				<div className="space-y-1.5 pt-1">
					{Array.from({ length: PLACEHOLDER_ROWS }, (_, row) => (
						<Skeleton key={row} className="h-3 w-1/2 rounded-md" />
					))}
				</div>
			</div>
		</div>
	);
}

/** The heading and the sentence under it, for each of the three answers. */
function describe(notes: ExportNotes): { title: string; body?: string } {
	if (notes.direction === "skeleton") {
		return {
			title: "New OpenAPI document",
			body: "A starting point. Collections, scripts and variables are included so Vayu can re-import it.",
		};
	}
	if (notes.boundMode === "full") {
		return {
			title: "Your spec, all edits applied",
			body: "Schemas and anything Vayu does not edit are left as they were.",
		};
	}
	// The hint under the toggle already says what this mode does.
	return { title: "Your spec, values updated" };
}

/**
 * What the export is about to write, and what it could not carry: only counts a user can act on or
 * would miss, and only when not zero, except the headline count, as "0 requests exported" is the
 * one zero that is news. The engine's notes carry more (shared `$ref` parameters, schema-sampled
 * examples), which the MCP tool still reports.
 */
function ExportSummary({ notes }: { notes: ExportNotes }) {
	const bound = notes.direction === "document";
	const contract = bound && notes.boundMode !== "full";
	const { title, body } = describe(notes);
	return (
		<div className="enter-fade rounded-md border border-rule surface-sunken p-3 space-y-2">
			<p className="flex items-center gap-2 text-xs font-semibold">
				<FileJson className="size-icon-sm text-primary shrink-0" />
				{title}
				<span className="font-normal text-muted-foreground">({notes.dialect})</span>
			</p>
			{body && <p className="text-label text-muted-foreground">{body}</p>}
			<ul className="text-label text-muted-foreground space-y-0.5">
				<Line always count={notes.requestsExported} label="request" suffix="exported" />
				{contract ? (
					<>
						<Line
							count={notes.requestsWithoutOperation}
							label="new request"
							suffix="not added - choose All edits"
						/>
						<Line
							count={notes.operationsNotInDocument}
							label="request"
							suffix="no longer in the spec - skipped"
						/>
						<Line
							count={notes.bodiesNotWritten}
							label="request body"
							plural="request bodies"
							suffix="not written"
						/>
						<Line
							count={notes.rowsNotDeclared}
							label="added parameter"
							suffix="not written"
						/>
					</>
				) : (
					<>
						{bound && (
							<Line
								count={notes.operationsAdded}
								label="new request"
								suffix="added"
							/>
						)}
						<Line
							count={notes.requestsOnlyInExtension}
							label="request"
							suffix="not visible to other tools"
						/>
					</>
				)}
				<Line count={notes.secretsOmitted} label="secret" suffix="written empty" />
				{bound && (
					<Line
						count={notes.operationsRemoved}
						label="unused operation"
						suffix="removed"
					/>
				)}
				<Line count={notes.examplesWritten} label="example" suffix="included" />
				<Line
					count={notes.examplesWithoutMediaType + notes.examplesTruncated}
					label="example"
					suffix="without a body"
				/>
				{bound && (
					<Line
						count={notes.examplesAlreadyDeclared}
						label="example"
						suffix="already in the spec"
					/>
				)}
			</ul>
			<p className="text-label text-muted-foreground">{BODIES_NOT_JUDGED}</p>
			{contract && notes.vocabularyNotWritten && (
				<p className="text-label text-muted-foreground">
					{notes.dialect}: values are not updated in this mode. Choose All edits to write
					them.
				</p>
			)}
		</div>
	);
}

/** What the withheld count does not cover, which the count above cannot say. */
const BODIES_NOT_JUDGED =
	"Bodies, examples, and scripts are not checked for credentials and are written as they are. Check them before you share the file.";

function Line({
	count,
	label,
	suffix,
	plural = `${label}s`,
	always = false,
}: {
	count: number;
	label: string;
	plural?: string;
	suffix: string;
	always?: boolean;
}) {
	if (count === 0 && !always) return null;
	return (
		<li>
			<span className="text-foreground">{count}</span> {pluralize(count, label, plural)}{" "}
			{suffix}
		</li>
	);
}
