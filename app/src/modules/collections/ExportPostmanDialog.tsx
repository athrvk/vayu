/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A collection out as a Postman Collection v2.1 document, built like its sibling `ExportSpecDialog`
 * on purpose: the engine assembles the document (`POST /export/postman`), the dialog states what it
 * is about to write and what it could not carry, and delivery is the repo's one file-to-disk path,
 * `downloadTextFile` (it closes once the file is written, stays open on a cancelled save dialog,
 * and says why a write failed, #3246). Mounted only while open, so the mount is the reset and the
 * credentials choice starts off on every opening.
 *
 * **The one choice is whether credentials travel.** A Postman export is usually headed for somebody
 * else, so the default writes credentials empty (auth, secret variables, and by name the headers,
 * parameters, URLs and cookies) and says how many it left out; switched on, it writes them as
 * stored, as Postman's own export does. Bodies and scripts are never judged, and the dialog says so
 * while credentials are off.
 *
 * **Nothing Postman has no place for is dropped silently**: the engine names each kind in
 * `notes.notCarried` with a count and its own sentence, all listed here as written.
 *
 * The previous answer stays on screen while the toggle re-reads (issue #1311), for the OpenAPI
 * dialog's reason: the counts are the collection's, and a dialog centred on itself moves both edges
 * for every block that comes and goes. `secretsOmitted`, the one count that depends on the switch,
 * is read against its current position.
 */

import { useState } from "react";
import { Copy, Download, FileJson, Loader2 } from "lucide-react";

import {
	Button,
	Dialog,
	DialogBody,
	DialogCancelButton,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	ICON_MOTION,
	Label,
	Skeleton,
	Switch,
} from "@/components/ui";
import { Callout } from "@/components/shared";
import { useCopy } from "@/hooks/useCopy";
import { ENGINE_NO_ANSWER } from "@/lib/engine-error-text";
import { downloadTextFile } from "@/lib/download-text-file";
import { usePostmanExportQuery } from "@/queries/exports";
import type { Collection, PostmanExportNotes } from "@/types";
import { pluralize } from "@/modules/dashboard/utils/format";

export interface ExportPostmanDialogProps {
	/**
	 * The collection to export. Non-null: the caller mounts this only once a
	 * collection has been chosen and unmounts it on close, so the credentials
	 * choice starts off every time rather than carrying the last one over.
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

export default function ExportPostmanDialog({
	collection,
	onOpenChange,
	onCloseAutoFocus,
}: ExportPostmanDialogProps) {
	const [includeSecrets, setIncludeSecrets] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const exported = usePostmanExportQuery(collection.id, includeSecrets);
	const { copy } = useCopy();

	const result = exported.data;
	const firstRead = exported.isPending;
	const reassembling = exported.isFetching && !firstRead;

	const handleDownload = async () => {
		if (!result) return;
		setSaveError(null);
		const saved = await downloadTextFile(result.text, result.fileName, "application/json");
		if (saved.outcome === "saved") onOpenChange(false);
		if (saved.outcome === "failed") setSaveError(saved.message);
	};

	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-xl" onCloseAutoFocus={onCloseAutoFocus}>
				<DialogHeader>
					<DialogTitle>Export as Postman Collection</DialogTitle>
					<DialogDescription>
						Save {collection.name} as a Postman Collection v2.1 file. Nothing leaves
						your machine.
					</DialogDescription>
				</DialogHeader>

				<DialogBody className="space-y-3">
					<div className="flex items-center justify-between gap-4">
						<Label htmlFor="export-postman-secrets" className="leading-snug">
							<span className="flex items-center gap-2">
								Include credentials
								{/*
								 * Beside the label, because the switch is what set it
								 * going and the card below stays where it is.
								 */}
								{reassembling && (
									<span
										role="status"
										aria-label="Assembling the collection"
										className="text-muted-foreground"
									>
										<Loader2
											className="size-icon-sm animate-spin"
											aria-hidden="true"
										/>
									</span>
								)}
							</span>
							<span className="block text-xs font-normal text-muted-foreground">
								{includeSecrets
									? "Everything is written as stored, as Postman's own export does. Share the file with care."
									: "Auth secrets, secret variables, and credentials in headers, parameters, URLs, and cookies are written empty. Turn on to write them as stored."}
							</span>
						</Label>
						<Switch
							id="export-postman-secrets"
							checked={includeSecrets}
							onCheckedChange={setIncludeSecrets}
						/>
					</div>

					{firstRead && <SummarySkeleton />}

					{exported.error && (
						<Callout severity="blocking" title="Couldn't assemble the collection">
							{errorText(exported.error)}
						</Callout>
					)}

					{result && (
						<ExportSummary notes={result.notes} includeSecrets={includeSecrets} />
					)}

					{saveError && (
						<Callout severity="blocking" title="Couldn't save the file">
							{saveError}
						</Callout>
					)}
				</DialogBody>

				<DialogFooter>
					<DialogCancelButton onClick={() => onOpenChange(false)} />
					{/*
					 * Disabled while the toggle re-reads, not only while empty: the held answer is
					 * the *previous* one, so a click then would copy credentials the switch just
					 * took out, or omit ones it just put in.
					 */}
					<Button
						variant="outline"
						disabled={!result || reassembling}
						onClick={() => void copy(result?.text ?? "", "The collection")}
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

/** The engine's sentence when it sent one, else the transport's. */
function errorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message || ENGINE_NO_ANSWER;
}

/**
 * `ExportSummary`'s footprint, held while the first read is in flight, so the
 * dialog opens at about the height it will keep (issue #1311).
 */
const PLACEHOLDER_ROWS = 3;

function SummarySkeleton() {
	return (
		<div
			className="rounded-md border border-rule surface-sunken p-3 space-y-2"
			role="status"
			aria-label="Assembling the collection"
		>
			<div className="space-y-2" aria-hidden="true">
				<Skeleton className="h-4 w-2/3 rounded-md" />
				<div className="space-y-1.5 pt-1">
					{Array.from({ length: PLACEHOLDER_ROWS }, (_, row) => (
						<Skeleton key={row} className="h-3 w-1/2 rounded-md" />
					))}
				</div>
			</div>
		</div>
	);
}

/**
 * What the export is about to write, and what it could not carry. The two headline counts always
 * show ("0 requests exported" is news), the rest only when non-zero. `secretsOmitted` belongs to
 * the switch, not the collection, so it is read against the switch's current position: an answer
 * held while credentials are switched on does not go on saying they were left out. The
 * bodies-and-scripts note follows the same position, as a paragraph so it never reads as a count.
 */
function ExportSummary({
	notes,
	includeSecrets,
}: {
	notes: PostmanExportNotes;
	includeSecrets: boolean;
}) {
	const notCarried = notes.notCarried.filter((note) => note.count > 0);
	return (
		<div className="enter-fade rounded-md border border-rule surface-sunken p-3 space-y-2">
			<p className="flex items-center gap-2 text-xs font-semibold">
				<FileJson className="size-icon-sm text-primary shrink-0" />
				Postman Collection
				<span className="font-normal text-muted-foreground">(v2.1)</span>
			</p>
			<ul className="text-label text-muted-foreground space-y-0.5">
				<Line always count={notes.requestsExported} label="request" suffix="exported" />
				<Line
					always
					count={notes.foldersExported}
					label="nested collection"
					suffix="exported"
				/>
				{!includeSecrets && (
					<Line count={notes.secretsOmitted} label="secret" suffix="written empty" />
				)}
			</ul>
			{!includeSecrets && (
				<p className="text-label text-muted-foreground">{BODIES_NOT_JUDGED}</p>
			)}
			{notCarried.length > 0 && (
				<div className="space-y-1">
					<p
						id="export-postman-not-carried"
						className="text-label font-medium text-foreground"
					>
						Not carried
					</p>
					<ul
						className="text-label text-muted-foreground space-y-0.5"
						aria-labelledby="export-postman-not-carried"
					>
						{notCarried.map((note) => (
							<li key={note.code}>
								{note.message}{" "}
								<span className="text-foreground">({note.count})</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

/** What credentials-off does not cover, which the count above cannot say. */
const BODIES_NOT_JUDGED =
	"Bodies and scripts are not checked for credentials and are written as they are. Check them before you share the file.";

function Line({
	count,
	label,
	suffix,
	always = false,
}: {
	count: number;
	label: string;
	suffix: string;
	always?: boolean;
}) {
	if (count === 0 && !always) return null;
	return (
		<li>
			<span className="text-foreground">{count}</span> {pluralize(count, label)} {suffix}
		</li>
	);
}
