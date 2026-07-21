/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useRef, useState } from "react";
import { Upload, CheckCircle2, X, Folder, AlertTriangle } from "lucide-react";
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
	Textarea,
} from "@/components/ui";
import { useImportModalStore } from "@/stores";
import { useImportMutation } from "@/queries/import";
import { apiService } from "@/services/api";
import { parseImport } from "@/services/importers/factory";
import { UnrecognisedFormatError, type ImportResult } from "@/services/importers/types";
import { MethodBadge } from "@/components/shared";

type Tab = "file" | "url" | "paste";
type Phase = "idle" | "detecting" | "preview" | "error";

const FORMAT_BADGES = ["Postman v2.1", "Postman v2.0", "Insomnia v4", "OpenAPI 3.0", "OpenAPI 2.0"];

export function ImportModal() {
	const { isOpen, close } = useImportModalStore();
	const importMutation = useImportMutation();

	const [tab, setTab] = useState<Tab>("file");
	const [phase, setPhase] = useState<Phase>("idle");
	const [error, setError] = useState("");
	const [result, setResult] = useState<ImportResult | null>(null);
	const [lastRaw, setLastRaw] = useState("");
	const [pasteText, setPasteText] = useState("");
	const [url, setUrl] = useState("");
	const [importEnvironments, setImportEnvironments] = useState(true);
	const [importScripts, setImportScripts] = useState(true);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const reset = () => {
		setPhase("idle");
		setError("");
		setResult(null);
		setLastRaw("");
		setPasteText("");
		setUrl("");
	};

	const handleClose = () => {
		if (importMutation.isPending) return;
		reset();
		close();
	};

	const detect = (
		raw: string,
		opts: { importEnvironments: boolean; importScripts: boolean },
		fileName?: string
	) => {
		try {
			const parsed = parseImport(raw, opts, fileName);
			setResult(parsed);
			setLastRaw(raw);
			setPhase("preview");
		} catch (e) {
			setResult(null);
			setError(
				e instanceof UnrecognisedFormatError ? "Unrecognised format" : (e as Error).message
			);
			setPhase("error");
		}
	};

	const runDetect = (raw: string, fileName?: string) => {
		setPhase("detecting");
		detect(raw, { importEnvironments, importScripts }, fileName);
	};

	// Re-parse the already-loaded source when an option toggle changes in preview.
	const redetect = (next: { importEnvironments: boolean; importScripts: boolean }) => {
		if (phase === "preview" && lastRaw) detect(lastRaw, next, result?.meta.fileName);
	};

	const handleFile = (file: File) => {
		const reader = new FileReader();
		reader.onload = () => runDetect(String(reader.result), file.name);
		reader.onerror = () => {
			setError("Could not read file");
			setPhase("error");
		};
		reader.readAsText(file);
	};

	const handleFetchUrl = async () => {
		setPhase("detecting");
		try {
			const { content } = await apiService.importFetch(url);
			detect(content, { importEnvironments, importScripts });
		} catch (e) {
			setError((e as Error).message);
			setPhase("error");
		}
	};

	const handleImport = async () => {
		if (!result) return;
		try {
			await importMutation.mutateAsync({
				result,
				opts: { importEnvironments, importScripts },
			});
			handleClose();
		} catch (e) {
			// Import failed (orchestrator rolled back) — surface it instead of silently re-enabling.
			setError((e as Error).message || "Import failed");
			setPhase("error");
		}
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
			{phase === "preview" && result ? (
				<PreviewView result={result} onDismiss={reset} />
			) : (
				<>
					{tab === "file" && (
						/*
						 * A real <button>, not a clickable div. This was a bare
						 * div with onClick: not focusable, not in the tab order,
						 * and not operable by Enter or Space — the only way to
						 * reach the file picker was a mouse. Drag-and-drop still
						 * works; the button is the keyboard path to the same
						 * hidden <input type="file">.
						 */
						<button
							type="button"
							className="w-full cursor-pointer rounded-lg border-2 border-dashed border-border-strong bg-accent px-6 py-9 text-center"
							onClick={() => fileInputRef.current?.click()}
							onDragOver={(e) => e.preventDefault()}
							onDrop={(e) => {
								e.preventDefault();
								const f = e.dataTransfer.files[0];
								if (f) handleFile(f);
							}}
						>
							<Upload className="mx-auto h-6 w-6 text-muted-foreground" />
							<span className="mt-2 block text-[13px] font-medium">
								Drop a file here, or click to browse
							</span>
							<span className="block text-[11px] text-muted-foreground">
								Format is detected automatically
							</span>
							<span className="mt-4 flex flex-wrap justify-center gap-1.5">
								{FORMAT_BADGES.map((b) => (
									<span
										key={b}
										className="rounded-md border border-border bg-card px-2 py-0.5 text-[10px] font-semibold"
									>
										{b}
									</span>
								))}
							</span>
						</button>
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
						className="hidden"
						onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
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
							/>
							<Button onClick={handleFetchUrl} disabled={!url}>
								Fetch
							</Button>
						</div>
					)}
					{tab === "paste" && (
						<div>
							<Textarea
								value={pasteText}
								onChange={(e) => setPasteText(e.target.value)}
								placeholder="Paste collection JSON or YAML here"
								className="h-40 w-full font-mono text-[12px]"
							/>
							<Button
								onClick={() => runDetect(pasteText)}
								disabled={!pasteText.trim()}
								className="mt-2"
							>
								Detect &amp; Preview
							</Button>
						</div>
					)}
					{phase === "error" && (
						<p className="mt-3 text-[12px] text-destructive-text">{error}</p>
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
		 * inerting of the background — all of which Radix gives for free, and
		 * none of which the app's other dialogs were missing.
		 *
		 * Radix now owns the shell: Escape, the overlay click, focus and the
		 * shared presentation animation. Only the body below is ImportModal's.
		 */
		<Dialog open={isOpen} onOpenChange={(next) => !next && handleClose()}>
			<DialogContent
				// Overrides the default padded grid: this dialog manages its own
				// header/tabs/body/footer bands, each with its own divider.
				className="flex w-[500px] max-w-[500px] max-h-[82vh] flex-col gap-0 overflow-hidden border-border-strong bg-card p-0"
				// No prose description; without this Radix logs a missing
				// aria-describedby warning.
				aria-describedby={undefined}
			>
				<DialogHeader className="flex-row items-center justify-between space-y-0 border-b border-border px-5 py-4">
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
				 * Radix also brings the keyboard model tabs are supposed to have —
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
					<TabsList className="h-auto w-full justify-start rounded-none border-b border-border bg-transparent p-0 px-5">
						{(["file", "url", "paste"] as Tab[]).map((t) => (
							<TabsTrigger
								key={t}
								value={t}
								className="shrink-0 rounded-none border-b-2 border-transparent px-4 py-2.5 text-[13px] data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
							>
								{t === "file" ? "File" : t === "url" ? "URL" : "Paste JSON"}
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
							 * differs wildly — the File dropzone is 247px tall, the URL row only
							 * 76 — and because the dialog is centred, that made the whole modal
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
					<div className="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
						<label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
							<span className="flex items-center gap-1.5">
								<input
									type="checkbox"
									checked={importEnvironments}
									onChange={(e) => toggleEnvironments(e.target.checked)}
								/>
								Import environments &amp; variables
							</span>
							<span className="flex items-center gap-1.5">
								<input
									type="checkbox"
									checked={importScripts}
									onChange={(e) => toggleScripts(e.target.checked)}
								/>
								Import pre-request &amp; test scripts
							</span>
						</label>
						<div className="flex gap-2">
							<Button
								variant="outline"
								onClick={handleClose}
								disabled={importMutation.isPending}
							>
								Cancel
							</Button>
							<Button onClick={handleImport} disabled={importMutation.isPending}>
								{importMutation.isPending ? "Importing…" : "Import →"}
							</Button>
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

function PreviewView({ result, onDismiss }: { result: ImportResult; onDismiss: () => void }) {
	const { meta, collections } = result;
	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2 rounded-md border border-status-success/20 bg-status-success/10 px-3 py-2">
				<CheckCircle2 className="h-4 w-4 text-status-success" />
				<span className="text-[12px] font-semibold">{meta.format}</span>
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
			<div className="max-h-[190px] overflow-y-auto rounded-md border border-border bg-accent p-2">
				{collections.map((c, i) => (
					<TreeNode key={i} name={c.name} requests={c.requests} children={c.children} />
				))}
			</div>
			<p className="text-[11px] text-muted-foreground">
				{meta.requestCount} requests · {meta.folderCount} folders · {meta.environmentCount}{" "}
				environments
			</p>
			{(meta.skipped.length > 0 || meta.nonExecutableAuth > 0) && (
				<p className="flex items-center gap-1.5 text-[11px] text-destructive-text">
					<AlertTriangle className="h-3.5 w-3.5" />
					{[
						...meta.skipped.map((s) => `${s.count} ${s.kind}`),
						...(meta.nonExecutableAuth > 0
							? [`${meta.nonExecutableAuth} auth not executed`]
							: []),
					].join(" · ")}
				</p>
			)}
		</div>
	);
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
			<div className="flex items-center gap-1.5 py-0.5 text-[12px] font-medium">
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
