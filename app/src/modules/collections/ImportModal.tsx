/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useRef, useState } from "react";
import {
	Upload,
	CheckCircle2,
	X,
	Folder,
	FolderOpen,
	Layers,
	Globe,
	AlertTriangle,
	FileWarning,
	Link2,
} from "lucide-react";
import {
	Button,
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	Input,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	TabLabel,
	Textarea,
} from "@/components/ui";
import { useImportModalStore, useTabsStore } from "@/stores";
import { useImportMutation } from "@/queries/import";
import { useCollectionsQuery } from "@/queries/collections";
import { useBoundSpecReader } from "@/queries/specs";
import {
	matchBoundSpecs,
	specCandidates,
	type SpecReimportMatch,
} from "@/services/openapi/bound-spec-match";
import SpecReimportDialog from "./SpecReimportDialog";
import { apiService } from "@/services/api";
import { type ImportResult, type SkippedItem } from "@/services/importers/types";
import { importFailureMessage } from "@/services/importers/failure-message";
import {
	applicableEntries,
	detectBatch,
	entryLabel,
	isImportableFileName,
	reparseBatch,
	type BatchDocument,
	type BatchEntry,
} from "@/services/importers/batch";
import { useSpecDocumentLimit } from "@/hooks/useSpecDocumentLimit";
import { MethodBadge } from "@/components/shared";

type Tab = "file" | "url" | "paste";
type Phase = "idle" | "detecting" | "preview" | "error";

const FORMAT_BADGES = [
	"Postman v2.1",
	"Postman v2.0",
	"Postman Env",
	"Postman Globals",
	"Insomnia v4",
	"OpenAPI 3.0",
	"OpenAPI 2.0",
];

export function ImportModal() {
	const { isOpen, close } = useImportModalStore();
	const importMutation = useImportMutation();
	const { data: collections = [] } = useCollectionsQuery();
	const readBoundSpecs = useBoundSpecReader();
	const openCollectionSpecTab = useTabsStore((s) => s.openCollectionSpecTab);

	const [tab, setTab] = useState<Tab>("file");
	const [phase, setPhase] = useState<Phase>("idle");
	const [error, setError] = useState("");
	/**
	 * One row per picked document, in pick order (issue #666).
	 *
	 * A single file is this same list with one entry, so the URL and Paste tabs -
	 * single by construction - travel the batch path rather than a second one
	 * beside it. Each entry carries its own bundled text, its own parse and its
	 * own apply outcome; nothing about a batch is derived from another file's.
	 */
	const [entries, setEntries] = useState<BatchEntry[]>([]);
	const [pasteText, setPasteText] = useState("");
	const [url, setUrl] = useState("");
	const [importEnvironments, setImportEnvironments] = useState(true);
	const [importScripts, setImportScripts] = useState(true);
	/**
	 * The documents in this import that a collection already binds, while the
	 * fork is on screen; `null` when it is not (issue #680).
	 */
	const [reimports, setReimports] = useState<SpecReimportMatch[] | null>(null);
	/** The bound-document lookup is a round trip - see `handleImport`. */
	const [checkingBindings, setCheckingBindings] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const folderInputRef = useRef<HTMLInputElement>(null);
	const { maxBytes: specMaxBytes } = useSpecDocumentLimit();

	/** The one-file case, which renders the full preview rather than a ledger row. */
	const single = entries.length === 1 ? entries[0] : null;
	/** What Import would send: included, parsed, and carrying something to create. */
	const applicable = applicableEntries(entries);

	const reset = () => {
		setPhase("idle");
		setError("");
		setEntries([]);
		setPasteText("");
		setUrl("");
		setReimports(null);
	};

	const handleClose = () => {
		if (importMutation.isPending || checkingBindings) return;
		reset();
		close();
	};

	/**
	 * Bundle, detect and parse everything the user just handed over (issue #649
	 * for the bundling, #666 for the "everything").
	 *
	 * A multi-file OpenAPI spec is only itself once its `$ref`s are followed, and
	 * bundling is async while parsing is not - so it happens here rather than
	 * inside `parseImport`, and what each parser (and the engine) then sees is one
	 * self-contained document. Both intakes are handed over and the batch layer
	 * uses whichever a given ref needs: a file already in this batch, a sibling on
	 * disk through the gated IPC, or an absolute URL through the engine proxy.
	 */
	const runBatch = async (documents: BatchDocument[]): Promise<void> => {
		if (documents.length === 0) return;
		setPhase("detecting");
		setError("");
		const readSpecFile = window.electronAPI?.readSpecFile;
		const next = await detectBatch(
			documents,
			{ importEnvironments, importScripts },
			{
				maxBytes: specMaxBytes,
				fetchUrl: async (target) => (await apiService.importFetch(target)).content,
				...(readSpecFile
					? {
							readSibling: async (specPath, refPath) => {
								const { bytes } = await readSpecFile(specPath, refPath);
								// UTF-8, exactly as `FileReader.readAsText` decoded the
								// document these bytes sit beside. A sibling that is not
								// UTF-8 fails to parse and is reported as an unresolved
								// ref, which is what it is.
								return new TextDecoder("utf-8").decode(bytes);
							},
						}
					: {}),
			}
		);
		setEntries(next);
		// One document that failed is the whole import failing, and says so where
		// it always did. Several is a ledger: the failures are rows in it, beside
		// the files that did parse, which is the only way a batch can report a
		// mixed outcome at all.
		if (next.length === 1 && next[0].error) {
			setError(next[0].error);
			setPhase("error");
			return;
		}
		setPhase("preview");
	};

	// Re-parse every entry when an option toggle changes in preview, from the text
	// already bundled - nothing is re-fetched, and each file keeps the source it
	// was read from. A re-parse that dropped the fetched URL would store a spec
	// with nothing to re-fetch from, and the toggles say nothing about where any
	// of the bytes came from.
	const redetect = (next: { importEnvironments: boolean; importScripts: boolean }) => {
		if (phase === "preview") setEntries((current) => reparseBatch(current, next));
	};

	/**
	 * Read one picked file into a batch document.
	 *
	 * A file that cannot be read at all - a directory in a drop, a file that moved
	 * between the pick and the read - becomes a document carrying that failure
	 * rather than nothing, because a picked file with no row anywhere is exactly
	 * the silent discard this flow exists to end.
	 */
	const readDocument = (file: File): Promise<BatchDocument> =>
		new Promise((resolve) => {
			// The path at pick time, while there is still a `File` to take it from -
			// `getFilePath` is a preload-local read of the object, not a channel the
			// renderer can name a path on. Empty outside Electron and for a
			// drag-and-drop of remote content, which is the state "no remembered
			// file" already means. It is also what a `$ref` to a sibling file on
			// disk is resolved against, in the main process - see `readSpecFile`.
			const specPath = window.electronAPI?.getFilePath(file) ?? "";
			// `webkitRelativePath` is set by a folder pick and empty otherwise, so a
			// flat drop is keyed by file name - which is the same thing for files
			// that share one directory.
			const relativePath = file.webkitRelativePath || file.name;
			const reader = new FileReader();
			reader.onload = () =>
				resolve({
					fileName: file.name,
					relativePath,
					specPath,
					text: String(reader.result),
				});
			reader.onerror = () =>
				resolve({
					fileName: file.name,
					relativePath,
					specPath,
					text: "",
					readError: "Could not read file",
				});
			reader.readAsText(file);
		});

	/**
	 * @param filterExtensions only for a folder pick, which hands over everything
	 * under the directory. A drop or an explicit selection is never filtered: the
	 * user named those files, and dropping one for its extension would be the
	 * silent discard this replaced.
	 */
	const handleFiles = async (files: File[], filterExtensions = false): Promise<void> => {
		const picked = filterExtensions ? files.filter((f) => isImportableFileName(f.name)) : files;
		if (picked.length === 0) {
			if (files.length > 0) {
				setError("No .json, .yaml or .yml files in that folder.");
				setPhase("error");
			}
			return;
		}
		setPhase("detecting");
		await runBatch(await Promise.all(picked.map(readDocument)));
	};

	// Fetching a URL is the only source the user can enter twice by hand, so it is
	// the one that needs the guard. `phase === "detecting"` was set here and in
	// the detect path and then never read by anything that renders - the button
	// stayed enabled and unchanged for the whole round-trip, so a second click
	// fired a second fetch whose result raced the first.
	const isFetching = phase === "detecting";

	const handleFetchUrl = async () => {
		if (isFetching) return;
		setPhase("detecting");
		try {
			const { content } = await apiService.importFetch(url);
			await runBatch([{ text: content, sourceUrl: url }]);
		} catch (e) {
			setError((e as Error).message);
			setPhase("error");
		}
	};

	/**
	 * What Import does: check for a document already bound, then apply
	 * (issue #680).
	 *
	 * The check runs here rather than at detect time for two reasons. It is a
	 * round trip per bound document, which nobody should pay for merely
	 * previewing a file - and Import is the last moment the answer can still
	 * change anything, since a collection may have been bound in another window
	 * since the preview was drawn.
	 *
	 * The lookup holds the button the way the apply does: `POST /import/apply` is
	 * create-only, so a second press while this is in flight would import
	 * everything twice.
	 */
	const handleImport = async () => {
		if (applicable.length === 0 || checkingBindings || importMutation.isPending) return;
		const candidates = specCandidates(applicable);
		if (candidates.length > 0) {
			setCheckingBindings(true);
			try {
				const matches = matchBoundSpecs(candidates, await readBoundSpecs(collections));
				if (matches.length > 0) {
					setReimports(matches);
					return;
				}
			} finally {
				setCheckingBindings(false);
			}
		}
		await runImport();
	};

	/**
	 * Apply the included files, **one transaction each** (issue #666).
	 *
	 * Sequential and per-file on purpose: `POST /import/apply` is atomic within
	 * one call, so a seventh file the engine refuses cannot roll back six good
	 * ones, and each file lands as its own root collection - exactly what N
	 * manual imports produce today. A single combined payload was rejected for
	 * the same reason: all-or-nothing across unrelated files is the wrong failure
	 * mode, and per-file leaves the engine contract untouched.
	 *
	 * Every attempted entry is unchecked afterwards, and an applied one can no
	 * longer be checked at all: the route is create-only and carries no
	 * idempotency key, so a second send is a second copy of the tree rather than
	 * a retry. A file that *failed* can be checked again - that is a deliberate
	 * act, and the only honest way to retry one - which is why the outcome stays
	 * on its row.
	 *
	 * Reached from Import, and from Import anyway on the re-import fork - which
	 * is why it does not re-check the bindings: the user has just answered that
	 * question.
	 */
	const runImport = async () => {
		if (applicable.length === 0) return;
		const outcomes = new Map<string, BatchEntry["outcome"]>();
		for (const entry of applicable) {
			const result = entry.result as ImportResult;
			try {
				await importMutation.mutateAsync({
					result,
					opts: { importEnvironments, importScripts },
					// Only meaningful for a spec import; the mutation ignores it when
					// the parsed tree carries no spec document.
					...(entry.specPath && result.meta.fileName
						? { specFile: { path: entry.specPath, fileName: result.meta.fileName } }
						: {}),
				});
				outcomes.set(entry.id, { ok: true, message: "Imported" });
			} catch (e) {
				// There is no rollback since #145: the engine write is atomic, so a validation
				// failure persisted nothing - but a failure *after* it (the id-map check, the
				// globals write) leaves the tree committed. Surface the error and leave the
				// modal open; the mutation invalidates on every outcome, so whatever did land
				// is already visible behind this dialog.
				//
				// The engine names the item that broke by its temp id; `importFailureMessage`
				// resolves that back to the name shown in the preview (issue #173).
				outcomes.set(entry.id, { ok: false, message: importFailureMessage(e, result) });
			}
		}
		const failures = [...outcomes.values()].filter((o) => o && !o.ok);
		if (failures.length === 0) {
			handleClose();
			return;
		}
		setEntries((current) =>
			current.map((entry) => {
				const outcome = outcomes.get(entry.id);
				return outcome ? { ...entry, outcome, included: false } : entry;
			})
		);
		// One file: the engine's own message, where it has always been. Several:
		// the count, because each row already carries its own message.
		setError(
			outcomes.size === 1
				? (failures[0]?.message ?? "Import failed")
				: `${failures.length} of ${outcomes.size} files failed to import.`
		);
	};

	/** Include or exclude one file of the batch. Nothing re-parses; only the apply set changes. */
	const toggleEntry = (id: string, included: boolean) => {
		setEntries((current) =>
			current.map((entry) => (entry.id === id ? { ...entry, included } : entry))
		);
	};

	const toggleEnvironments = (v: boolean) => {
		setImportEnvironments(v);
		redetect({ importEnvironments: v, importScripts });
	};
	const toggleScripts = (v: boolean) => {
		setImportScripts(v);
		redetect({ importEnvironments, importScripts: v });
	};

	// Shared by all three tab panels; the inner conditionals already switch on
	// the active tab, and only the active panel is mounted.
	const panelBody = (
		<>
			{phase === "preview" ? (
				<>
					{single?.result ? (
						<PreviewView
							result={single.result}
							importEnvironments={importEnvironments}
							onDismiss={reset}
						/>
					) : (
						<BatchLedger entries={entries} onToggle={toggleEntry} onDismiss={reset} />
					)}
					{/* An apply that failed leaves the list on screen - the per-file
					    outcomes are in it - so the message that would have replaced it
					    is stated here instead. */}
					{error && (
						<p className="mt-3 flex items-center gap-1.5 text-xs text-destructive-text">
							<AlertTriangle className="h-3.5 w-3.5 shrink-0" />
							{error}
						</p>
					)}
				</>
			) : (
				<>
					{tab === "file" && (
						/*
						 * A real <button>, not a clickable div. This was a bare
						 * div with onClick: not focusable, not in the tab order,
						 * and not operable by Enter or Space - the only way to
						 * reach the file picker was a mouse. Drag-and-drop still
						 * works; the button is the keyboard path to the same
						 * hidden <input type="file">.
						 */
						/*
						 * The dashed edge is a drag-target affordance and wants
						 * prominence - but on this fill (`--muted`/`--accent`)
						 * `--border-strong` is the *faintest* option in dark (1.108,
						 * below plain `--border` at 1.157), because the fill sits
						 * between the two tokens in lightness. `surface-sunken`'s
						 * alpha-of-foreground rule is the strongest edge available
						 * here in both themes (1.356 light / 1.343 dark), and its
						 * background is the same value `bg-accent` carried.
						 */
						<button
							type="button"
							className="w-full cursor-pointer rounded-lg border-2 border-dashed border-rule surface-sunken px-6 py-9 text-center"
							onClick={() => fileInputRef.current?.click()}
							onDragOver={(e) => e.preventDefault()}
							onDrop={(e) => {
								e.preventDefault();
								// Every dropped file, not `files[0]`: the input had no
								// `multiple` and this read one element, so a folder's
								// worth of specs imported the first and discarded the
								// rest without a word (issue #666).
								void handleFiles(Array.from(e.dataTransfer.files));
							}}
						>
							<Upload className="mx-auto h-6 w-6 text-muted-foreground" />
							<span className="mt-2 block text-sm font-medium">
								Drop files here, or click to browse
							</span>
							<span className="block text-[11px] text-muted-foreground">
								Format is detected per file - drop as many as you like
							</span>
							<span className="mt-4 flex flex-wrap justify-center gap-1.5">
								{FORMAT_BADGES.map((b) => (
									<span
										key={b}
										// Bare `bg-card` on purpose: the chip's edge faces the
										// sunken drop zone, so its `border-rule` must inherit the
										// zone's declaration, not declare a card rule of its own.
										className="rounded-md border border-rule bg-card px-2 py-0.5 text-[10px] font-semibold"
									>
										{b}
									</span>
								))}
							</span>
						</button>
					)}
					{tab === "file" && (
						<div className="mt-2 flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
							<span>Or bring in a whole directory of specs:</span>
							<Button
								variant="outline"
								size="sm"
								onClick={() => folderInputRef.current?.click()}
							>
								<FolderOpen className="mr-1.5 h-3.5 w-3.5" />
								Import folder
							</Button>
						</div>
					)}
					{/*
					 * Outside the button on purpose. Nested inside it, the
					 * programmatic .click() would bubble back to the button and
					 * re-enter this handler, and interactive content inside a
					 * button is invalid besides.
					 */}
					<input
						ref={fileInputRef}
						type="file"
						multiple
						className="hidden"
						onChange={(e) => void handleFiles(Array.from(e.target.files ?? []))}
					/>
					{/*
					 * The folder variant of the same input. `webkitdirectory` is not in
					 * React's attribute table - it is spread in rather than written as
					 * a prop, which is what makes it reach the DOM. Chromium (so
					 * Electron) is the only engine that implements it, and outside one
					 * the input degrades to an ordinary multi-file picker rather than
					 * failing.
					 *
					 * Filtered to importable extensions on the way in: a directory pick
					 * hands over everything under it, and a ledger of PNGs would bury
					 * the specs it was opened for.
					 */}
					<input
						ref={folderInputRef}
						type="file"
						multiple
						className="hidden"
						{...{ webkitdirectory: "", directory: "" }}
						onChange={(e) => void handleFiles(Array.from(e.target.files ?? []), true)}
					/>
					{tab === "url" && (
						<div className="flex gap-2">
							<Input
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && url) handleFetchUrl();
								}}
								placeholder="https://petstore.swagger.io/v2/swagger.json"
								className="flex-1"
								disabled={isFetching}
							/>
							<Button onClick={handleFetchUrl} disabled={!url || isFetching}>
								{isFetching ? "Fetching…" : "Fetch"}
							</Button>
						</div>
					)}
					{tab === "paste" && (
						<div>
							<Textarea
								value={pasteText}
								onChange={(e) => setPasteText(e.target.value)}
								placeholder="Paste collection JSON or YAML here"
								className="h-40 w-full font-mono text-xs"
							/>
							<Button
								onClick={() => void runBatch([{ text: pasteText }])}
								disabled={!pasteText.trim()}
								className="mt-2"
							>
								Detect &amp; Preview
							</Button>
						</div>
					)}
					{phase === "error" && (
						<p className="mt-3 text-xs text-destructive-text">{error}</p>
					)}
				</>
			)}
		</>
	);

	return (
		/*
		 * This used to hand-roll its own modal: a fixed backdrop, a bare
		 * role="dialog", a window keydown listener for Escape and its own close
		 * button. That meant no focus trap, no focus restore on close, no portal
		 * (so it rendered inside the tree that opened it), no scroll lock and no
		 * inerting of the background - all of which Radix gives for free, and
		 * none of which the app's other dialogs were missing.
		 *
		 * Radix now owns the shell: Escape, the overlay click, focus and the
		 * shared presentation animation. Only the body below is ImportModal's.
		 */
		<Dialog open={isOpen} onOpenChange={(next) => !next && handleClose()}>
			<DialogContent
				// Overrides the default padded grid: this dialog manages its own
				// header/tabs/body/footer bands, each with its own divider.
				//
				// `bg-card surface-card` must stay a pair: `surface-card` sets the
				// same background, but from `@layer components`, so the primitive's
				// `bg-background` utility would outrank it - and tailwind-merge does
				// not treat `surface-card` as a background class, so only `bg-card`
				// strips the primitive's. The utility wins the cascade; the surface
				// class contributes the `--rule` declaration the dividers below
				// resolve against.
				className="flex w-[500px] max-w-[500px] max-h-[82vh] flex-col gap-0 overflow-hidden border-border-strong bg-card surface-card p-0"
				// No prose description; without this Radix logs a missing
				// aria-describedby warning.
				aria-describedby={undefined}
			>
				<DialogHeader className="flex-row items-center justify-between space-y-0 border-b border-rule px-5 py-4">
					<DialogTitle className="text-sm font-bold tracking-tight">
						Import Collection
					</DialogTitle>
				</DialogHeader>

				{/*
				 * The app's Tabs primitive, styled like the request builder's
				 * underline tabs. These were hand-rolled buttons with `py-2` and no
				 * horizontal padding, which is what made the focus ring look wrong:
				 * the ring correctly wrapped a 73x38 box around 73px of text, so it
				 * read as a tall rectangle floating around the label. Every other
				 * tab in the app is px-4 py-2.5, so the ring wraps a proportioned
				 * target.
				 *
				 * Radix also brings the keyboard model tabs are supposed to have -
				 * one tab stop for the set, arrow keys to move between them. The
				 * hand-rolled version made each tab its own tab stop.
				 */}
				<Tabs
					value={tab}
					onValueChange={(v) => {
						setTab(v as Tab);
						reset();
					}}
					className="flex min-h-0 flex-1 flex-col"
				>
					<TabsList className="w-full px-4">
						{(["file", "url", "paste"] as Tab[]).map((t) => (
							<TabsTrigger key={t} value={t}>
								<TabLabel>
									{t === "file" ? "File" : t === "url" ? "URL" : "Paste JSON"}
								</TabLabel>
							</TabsTrigger>
						))}
					</TabsList>

					{/*
					 * One panel per tab, not a single panel for the active value: Radix
					 * points each trigger's aria-controls at the panel for its own value,
					 * so rendering only the active one left the other two referencing ids
					 * that did not exist. Only the active panel mounts, so the shared body
					 * below still renders exactly once.
					 */}
					{(["file", "url", "paste"] as Tab[]).map((t) => (
						<TabsContent
							key={t}
							value={t}
							/*
							 * min-h holds the three tabs to one height. Their natural content
							 * differs wildly - the File dropzone is 247px tall, the URL row only
							 * 76 - and because the dialog is centred, that made the whole modal
							 * resize by 171px and jump 85px up the screen when you switched to
							 * URL. Sized to the tallest tab, so the shell never moves.
							 */
							className="mt-0 min-h-[248px] overflow-y-auto p-5"
						>
							{panelBody}
						</TabsContent>
					))}
				</Tabs>

				{phase === "preview" && (
					<div className="flex items-center justify-between gap-3 border-t border-rule px-5 py-4">
						{/*
						 * One <label> each. These were two checkboxes inside a single
						 * <label>: a label's control is its *first* labelable
						 * descendant, so clicking the words "Import pre-request &
						 * test scripts" toggled Import environments instead - and the
						 * second checkbox had no label at all, shrinking its hit
						 * target to the 13px box.
						 */}
						<div className="flex flex-col gap-1 text-[11px] text-muted-foreground">
							<label className="flex w-fit items-center gap-1.5">
								<input
									type="checkbox"
									checked={importEnvironments}
									onChange={(e) => toggleEnvironments(e.target.checked)}
								/>
								Import environments &amp; variables
							</label>
							<label className="flex w-fit items-center gap-1.5">
								<input
									type="checkbox"
									checked={importScripts}
									onChange={(e) => toggleScripts(e.target.checked)}
								/>
								Import pre-request &amp; test scripts
							</label>
						</div>
						<div className="flex gap-2">
							<Button
								variant="outline"
								onClick={handleClose}
								disabled={importMutation.isPending}
							>
								Cancel
							</Button>
							<Button
								onClick={handleImport}
								disabled={
									importMutation.isPending ||
									checkingBindings ||
									applicable.length === 0
								}
							>
								{importMutation.isPending || checkingBindings
									? "Importing…"
									: // The count only appears for a batch: it is what the
										// button is about to do N times, and on one file it
										// would just restate the preview.
										applicable.length > 1
										? `Import ${applicable.length} files →`
										: "Import →"}
							</Button>
						</div>
					</div>
				)}

				{/* Mounted only while the fork is on screen, over this dialog: the
				    preview underneath is what Cancel goes back to, and what Import
				    anyway then imports. */}
				{reimports && (
					<SpecReimportDialog
						matches={reimports}
						onSync={(collectionId) => {
							setReimports(null);
							// Before the close, which resets this component's state:
							// the store call is what survives it.
							openCollectionSpecTab(collectionId);
							handleClose();
						}}
						onImportAnyway={() => {
							setReimports(null);
							void runImport();
						}}
						onCancel={() => setReimports(null)}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

function PreviewView({
	result,
	importEnvironments,
	onDismiss,
}: {
	result: ImportResult;
	importEnvironments: boolean;
	onDismiss: () => void;
}) {
	const { meta, collections, environments, globals } = result;
	const globalCount = Object.keys(globals).length;
	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2 rounded-md border border-status-success/20 bg-status-success/10 px-3 py-2">
				<CheckCircle2 className="h-4 w-4 text-status-success-text" />
				<span className="text-xs font-semibold">{meta.format}</span>
				{meta.fileName && (
					<span className="font-mono text-[11px] text-muted-foreground">
						{meta.fileName}
					</span>
				)}
				<button
					className="ml-auto text-muted-foreground hover:text-foreground"
					onClick={onDismiss}
					aria-label="Dismiss"
				>
					<X className="h-3.5 w-3.5" />
				</button>
			</div>
			<div className="max-h-[190px] overflow-y-auto rounded-md border border-rule surface-sunken p-2">
				{collections.map((c, i) => (
					<TreeNode key={i} name={c.name} requests={c.requests} children={c.children} />
				))}
				{/*
				 * Environments were parsed but never shown. For a Postman environment
				 * export they are the entire import, so the box rendered empty.
				 */}
				{environments.map((e, i) => (
					<div
						key={i}
						className="flex items-center gap-1.5 py-0.5 pl-1 text-xs font-medium"
					>
						<Layers className="h-3.5 w-3.5 text-primary" />
						{e.name}
						<span className="text-[11px] font-normal text-muted-foreground">
							{varCountLabel(Object.keys(e.variables).length)}
						</span>
					</div>
				))}
				{/*
				 * Globals have no name of their own - they are a singleton scope, not a
				 * named environment - so the row names the destination rather than the file.
				 */}
				{globalCount > 0 && (
					<div className="flex items-center gap-1.5 py-0.5 pl-1 text-xs font-medium">
						<Globe className="h-3.5 w-3.5 text-primary" />
						Globals
						<span className="text-[11px] font-normal text-muted-foreground">
							{varCountLabel(globalCount)}
						</span>
					</div>
				)}
			</div>
			{/* `exampleCount` is here rather than only in the tree because a saved
			    example is the one thing in an import with no row of its own to
			    look at - it lands inside a request, and until this line the count
			    every parser computed was rendered nowhere at all (issue #481,
			    acceptance criterion 1). Unconditional like the other four: "0
			    examples" is the answer for a file that carried none, which is
			    different from a preview that does not mention them. */}
			<p className="text-[11px] text-muted-foreground">
				{meta.requestCount} requests · {meta.folderCount} folders · {meta.exampleCount}{" "}
				examples · {meta.environmentCount} environments · {meta.globalCount} globals
			</p>
			{collections.length === 0 && environments.length === 0 && globalCount === 0 && (
				<p className="flex items-center gap-1.5 text-[11px] text-destructive-text">
					<AlertTriangle className="h-3.5 w-3.5" />
					{importEnvironments
						? "Nothing to import from this file."
						: "No collections in this file. Enable Import environments & variables below to import its environments."}
				</p>
			)}
			{globalCount > 0 && (
				<p className="text-[11px] text-muted-foreground">
					Existing globals are kept; a variable of the same name is overwritten.
				</p>
			)}
			{lossSummary(meta) && (
				<p className="flex items-center gap-1.5 text-[11px] text-destructive-text">
					<AlertTriangle className="h-3.5 w-3.5" />
					{lossSummary(meta)}
				</p>
			)}
		</div>
	);
}

/**
 * What this file lost, in words - or `""` when it lost nothing.
 *
 * Shared by the single-file preview and every ledger row rather than written
 * twice: a batch has to state per file exactly what one file states on its own,
 * and a copy of this list is a copy that stops matching the first time a skip
 * kind is added.
 */
function lossSummary(meta: ImportResult["meta"]): string {
	return [
		...meta.skipped.map((s) => `${s.count} ${skippedLabel(s.kind, s.count)}`),
		...(meta.nonExecutableAuth > 0 ? [`${meta.nonExecutableAuth} auth not executed`] : []),
		// An OpenAPI upload imports as a file row with nothing attached - the user
		// has to pick the file before the request can be sent, so the preview says
		// how many are waiting rather than letting them be discovered one 400 at a
		// time.
		...(meta.unattachedFileParts > 0
			? [
					`${meta.unattachedFileParts} file ${
						meta.unattachedFileParts === 1 ? "part needs" : "parts need"
					} a file`,
				]
			: []),
	].join(" · ");
}

/**
 * The batch ledger: one row per picked file (issue #666).
 *
 * Every file the user handed over has a row, whatever became of it - parsed,
 * unrecognised, unreadable, or inlined into another document as a `$ref` target.
 * That is the whole point: the flow this replaced kept the first file and said
 * nothing about the rest, so "there is a row for it" is the property to hold on
 * to, and a row that says "Unrecognised format" is doing its job.
 *
 * Rows that cannot be imported start unchecked, and the checkbox is the only
 * thing the user has to touch: the counts, the losses and the outcome are all
 * stated per file, in the same words the single-file preview uses.
 */
function BatchLedger({
	entries,
	onToggle,
	onDismiss,
}: {
	entries: BatchEntry[];
	onToggle: (id: string, included: boolean) => void;
	onDismiss: () => void;
}) {
	const selected = applicableEntries(entries).length;
	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2 rounded-md border border-status-success/20 bg-status-success/10 px-3 py-2">
				<CheckCircle2 className="h-4 w-4 text-status-success-text" />
				<span className="text-xs font-semibold">{entries.length} files</span>
				<span className="text-[11px] text-muted-foreground">
					{selected} selected for import
				</span>
				<button
					className="ml-auto text-muted-foreground hover:text-foreground"
					onClick={onDismiss}
					aria-label="Dismiss"
				>
					<X className="h-3.5 w-3.5" />
				</button>
			</div>
			<div className="max-h-[190px] overflow-y-auto rounded-md border border-rule surface-sunken p-2">
				{entries.map((entry) => (
					<BatchRow key={entry.id} entry={entry} onToggle={onToggle} />
				))}
			</div>
			<p className="text-[11px] text-muted-foreground">
				Each file is imported on its own, as its own collection - a file the engine refuses
				does not undo the ones before it.
			</p>
		</div>
	);
}

function BatchRow({
	entry,
	onToggle,
}: {
	entry: BatchEntry;
	onToggle: (id: string, included: boolean) => void;
}) {
	const { result, error, bundledInto, outcome } = entry;
	// Shared with the re-import dialog, so one file is called the same thing
	// wherever it is named.
	const name = entryLabel(entry);
	const loss = result ? lossSummary(result.meta) : "";
	return (
		<label className="flex items-start gap-2 py-1 pl-1 text-xs">
			<input
				type="checkbox"
				className="mt-1"
				checked={entry.included}
				// An applied file is the one thing that must not be re-sent:
				// `POST /import/apply` is create-only and carries no idempotency key,
				// so a second send is a second copy of the tree, not a retry.
				disabled={!result || outcome?.ok === true}
				onChange={(e) => onToggle(entry.id, e.target.checked)}
				aria-label={name}
			/>
			<span className="min-w-0 flex-1">
				<span className="flex items-baseline gap-1.5">
					<span className="truncate font-medium">{name}</span>
					{result && (
						<span className="shrink-0 text-[10px] font-semibold text-muted-foreground">
							{result.meta.format}
						</span>
					)}
				</span>
				{result && (
					<span className="block text-[11px] text-muted-foreground">
						{result.meta.requestCount} requests · {result.meta.folderCount} folders ·{" "}
						{result.meta.exampleCount} examples · {result.meta.environmentCount}{" "}
						environments · {result.meta.globalCount} globals
					</span>
				)}
				{bundledInto && (
					<span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
						<Link2 className="h-3 w-3 shrink-0" />
						Referenced by {bundledInto} - imported as part of it
					</span>
				)}
				{error && (
					<span className="flex items-center gap-1.5 text-[11px] text-destructive-text">
						<FileWarning className="h-3 w-3 shrink-0" />
						{error}
					</span>
				)}
				{loss && (
					<span className="flex items-center gap-1.5 text-[11px] text-destructive-text">
						<AlertTriangle className="h-3 w-3 shrink-0" />
						{loss}
					</span>
				)}
				{outcome && (
					<span
						className={`flex items-center gap-1.5 text-[11px] ${
							outcome.ok ? "text-status-success-text" : "text-destructive-text"
						}`}
					>
						{outcome.ok ? (
							<CheckCircle2 className="h-3 w-3 shrink-0" />
						) : (
							<FileWarning className="h-3 w-3 shrink-0" />
						)}
						{outcome.message}
					</span>
				)}
			</span>
		</label>
	);
}

function varCountLabel(n: number): string {
	return `${n} ${n === 1 ? "variable" : "variables"}`;
}

/**
 * What a skipped item is, in words.
 *
 * The kinds are slugs - the line read "3 file_body · 1 malformed_item", which
 * names the parser's counter rather than what the user lost. `file_body` in
 * particular no longer means "a file part was dropped" (issue #393 imports
 * those): it is now only a *whole-body* file - Postman's `file` mode, an
 * Insomnia binary body - which Vayu has no shape for, so the wording has to say
 * which of the two the reader is looking at.
 */
const SKIPPED_LABELS: Record<SkippedItem["kind"], [singular: string, plural: string]> = {
	websocket: ["WebSocket request", "WebSocket requests"],
	grpc: ["gRPC request", "gRPC requests"],
	api_spec: ["API spec document", "API spec documents"],
	unit_test: ["unit-test block", "unit-test blocks"],
	file_body: ["file body (not supported)", "file bodies (not supported)"],
	malformed_item: ["malformed item", "malformed items"],
	unsupported_method: ["unsupported method", "unsupported methods"],
	malformed_spec: ["malformed spec section", "malformed spec sections"],
	example_no_status: [
		"example response with no numeric status",
		"example responses with no numeric status",
	],
	// Not "external ref": the count is what the user lost, and what they lost is
	// a schema the spec pointed at in another file (issue #649). The wording says
	// which half failed - Vayu found the reference and could not read the file.
	external_ref: [
		"reference to a file Vayu could not read",
		"references to files Vayu could not read",
	],
};

function skippedLabel(kind: SkippedItem["kind"], count: number): string {
	const label = SKIPPED_LABELS[kind];
	// A kind with no entry still says something rather than nothing - the union
	// is exhaustive today, and a new kind must not silently print `undefined`.
	if (!label) return kind;
	return count === 1 ? label[0] : label[1];
}

function TreeNode({
	name,
	requests,
	children,
}: {
	name: string;
	requests: ImportResult["collections"][number]["requests"];
	children: ImportResult["collections"][number]["children"];
}) {
	return (
		<div className="pl-1">
			<div className="flex items-center gap-1.5 py-0.5 text-xs font-medium">
				<Folder className="h-3.5 w-3.5 text-primary" />
				{name}
			</div>
			<div className="pl-5">
				{requests.map((r, i) => (
					<div
						key={i}
						className="flex items-center gap-2 py-0.5 text-[11px] text-muted-foreground"
					>
						<MethodBadge method={r.method} variant="text" className="w-10" />
						<span>{r.name}</span>
					</div>
				))}
				{children.map((c, i) => (
					<TreeNode key={i} name={c.name} requests={c.requests} children={c.children} />
				))}
			</div>
		</div>
	);
}
