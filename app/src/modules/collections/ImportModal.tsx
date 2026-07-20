/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect, useRef, useState } from "react";
import { Upload, CheckCircle2, X, Folder, AlertTriangle } from "lucide-react";
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

	useEffect(() => {
		if (!isOpen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") handleClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isOpen, importMutation.isPending]);

	if (!isOpen) return null;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
			onClick={handleClose}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Import Collection"
				className="flex w-[500px] max-h-[82vh] flex-col overflow-hidden rounded-lg border border-border-strong bg-card shadow-2xl"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center justify-between border-b border-border px-5 py-4">
					<h2 className="text-sm font-bold tracking-tight">Import Collection</h2>
					<button
						onClick={handleClose}
						className="text-muted-foreground hover:text-foreground"
						aria-label="Close"
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				<div role="tablist" className="flex gap-4 border-b border-border px-5">
					{(["file", "url", "paste"] as Tab[]).map((t) => (
						<button
							key={t}
							role="tab"
							id={`import-tab-${t}`}
							aria-selected={tab === t}
							aria-controls="import-tabpanel"
							onClick={() => {
								setTab(t);
								reset();
							}}
							className={`-mb-px border-b-2 py-2 text-[13px] ${tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground"}`}
						>
							{t === "file" ? "File" : t === "url" ? "URL" : "Paste JSON"}
						</button>
					))}
				</div>

				<div
					role="tabpanel"
					id="import-tabpanel"
					aria-labelledby={`import-tab-${tab}`}
					className="overflow-y-auto p-5"
				>
					{phase === "preview" && result ? (
						<PreviewView result={result} onDismiss={reset} />
					) : (
						<>
							{tab === "file" && (
								<div
									className="cursor-pointer rounded-lg border-2 border-dashed border-border-strong bg-accent px-6 py-9 text-center"
									onClick={() => fileInputRef.current?.click()}
									onDragOver={(e) => e.preventDefault()}
									onDrop={(e) => {
										e.preventDefault();
										const f = e.dataTransfer.files[0];
										if (f) handleFile(f);
									}}
								>
									<Upload className="mx-auto h-6 w-6 text-muted-foreground" />
									<p className="mt-2 text-[13px] font-medium">
										Drop a file here, or click to browse
									</p>
									<p className="text-[11px] text-muted-foreground">
										Format is detected automatically
									</p>
									<input
										ref={fileInputRef}
										type="file"
										className="hidden"
										onChange={(e) =>
											e.target.files?.[0] && handleFile(e.target.files[0])
										}
									/>
									<div className="mt-4 flex flex-wrap justify-center gap-1.5">
										{FORMAT_BADGES.map((b) => (
											<span
												key={b}
												className="rounded-md border border-border bg-card px-2 py-0.5 text-[10px] font-semibold"
											>
												{b}
											</span>
										))}
									</div>
								</div>
							)}
							{tab === "url" && (
								<div className="flex gap-2">
									<input
										value={url}
										onChange={(e) => setUrl(e.target.value)}
										placeholder="https://petstore.swagger.io/v2/swagger.json"
										className="h-9 flex-1 rounded-md border border-border bg-card px-3 text-[13px]"
									/>
									<button
										onClick={handleFetchUrl}
										disabled={!url}
										className="h-9 rounded-md bg-primary-fill px-4 text-[13px] font-semibold text-white disabled:opacity-50"
									>
										Fetch
									</button>
								</div>
							)}
							{tab === "paste" && (
								<div>
									<textarea
										value={pasteText}
										onChange={(e) => setPasteText(e.target.value)}
										placeholder="Paste collection JSON or YAML here"
										className="h-40 w-full rounded-md border border-border bg-card p-3 font-mono text-[12px]"
									/>
									<button
										onClick={() => runDetect(pasteText)}
										disabled={!pasteText.trim()}
										className="mt-2 h-9 rounded-md bg-primary-fill px-4 text-[13px] font-semibold text-white disabled:opacity-50"
									>
										Detect &amp; Preview
									</button>
								</div>
							)}
							{phase === "error" && (
								<p
									className="mt-3 text-[12px]"
									style={{ color: "var(--destructive-text)" }}
								>
									{error}
								</p>
							)}
						</>
					)}
				</div>

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
							<button
								onClick={handleClose}
								disabled={importMutation.isPending}
								className="h-9 rounded-md border border-border px-4 text-[13px]"
							>
								Cancel
							</button>
							<button
								onClick={handleImport}
								disabled={importMutation.isPending}
								className="h-9 rounded-md bg-primary-fill px-4 text-[13px] font-semibold text-white disabled:opacity-50"
							>
								{importMutation.isPending ? "Importing…" : "Import →"}
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

function PreviewView({ result, onDismiss }: { result: ImportResult; onDismiss: () => void }) {
	const { meta, collections } = result;
	return (
		<div className="space-y-3">
			<div
				className="flex items-center gap-2 rounded-md border px-3 py-2"
				style={{ background: "rgba(34,197,94,0.08)", borderColor: "rgba(34,197,94,0.22)" }}
			>
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
				<p
					className="flex items-center gap-1.5 text-[11px]"
					style={{ color: "var(--destructive-text)" }}
				>
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
