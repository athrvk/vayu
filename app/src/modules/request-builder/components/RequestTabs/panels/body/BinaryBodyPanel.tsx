/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The `binary` body: one file, sent as the whole request body.
 *
 * **A path, never bytes.** The engine opens the file at send time - small
 * files read once, large ones streamed - so the editor holds a path and what
 * the user said about it. The file is chosen three ways: dropped on the
 * panel, picked with Choose file (both through `file-pick.ts`, the piece a
 * form-data file part uses too), or typed into the path field, which is how a
 * `{{fixturesDir}}/a.bin` path is written.
 *
 * **Only a pick chooses a file** (#2356). Vayu sends a file picked on this
 * machine, or any file under a folder you allowed. Picking and dropping go
 * through the preload, which hands the main process the path to grant, so
 * either one clears the banner below. A typed path is not a pick: until the
 * engine answers for it on the next read (`unresolved`, `lib/file-trust.ts`)
 * it reads as not chosen, the same as an imported or pasted one. A path with a
 * `{{variable}}` in it is sent only from an allowed folder, because the
 * variable could point anywhere. The banner offers the two ways out - Relink
 * (pick the file here) and Allow folder - and goes quiet when the path already
 * sits under an allowed folder. That check is the text comparison in
 * `lib/file-path.ts`, a display answer; the engine's own check is on
 * canonical paths and is the one that decides.
 *
 * **The size line asks the main process** (`statFile`), which answers size
 * and modification time for an absolute path and never reads the file. It
 * answers only for a picked file or one under an allowed folder (#2357), and
 * null for everything else, so "Not found on this machine" also covers a typed
 * path outside every allowed folder that was never picked.
 */

import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import { FileUp } from "lucide-react";
import { Button, Label } from "@/components/ui";
import { Callout } from "@/components/shared/Callout";
import VariableInput from "@/components/shared/VariableInput";
import { useFilePick, pickedFileOf, type PickedFile } from "@/components/shared/file-pick";
import { containsVariableToken } from "@/constants/variables";
import { fileBaseName, isUnderFolder } from "@/lib/file-path";
import { flagAfterPick, isUnresolved, noFile } from "@/lib/file-trust";
import { cn } from "@/lib/utils";
import { formatSize } from "@/components/shared/response-viewer/utils";
import { useAllowFolder } from "@/hooks/useAllowFolder";
import { useFileRootsQuery } from "@/queries";
import type { FileRef } from "@/types";
import { useRequestBuilderContext } from "../../../../context";
import { useVariableSupport } from "../../../../hooks/useVariableSupport";
import { binaryContentType } from "./binary-content-type";

/** What the size line knows: not asked yet, asked and found, or asked and absent. */
type StatState = { path: string; size: number } | { path: string; missing: true } | null;

/** The file this panel describes, after the path's variables are resolved. */
function useResolvedPath(src: string, resolveString: (s: string) => string): string {
	return useMemo(
		() => (containsVariableToken(src) ? resolveString(src) : src).trim(),
		[src, resolveString]
	);
}

/** Ask the main process for the file's size; nothing outside Electron. */
function useFileSize(path: string): StatState {
	const [state, setState] = useState<StatState>(null);
	useEffect(() => {
		const statFile = window.electronAPI?.statFile;
		if (!statFile || !path || containsVariableToken(path)) return;
		let current = true;
		void statFile(path)
			.then((info) => {
				if (!current) return;
				setState(info ? { path, size: info.size } : { path, missing: true });
			})
			.catch(() => {
				if (current) setState(null);
			});
		return () => {
			current = false;
		};
	}, [path]);
	// A stale answer for the previous path is no answer.
	return state && state.path === path ? state : null;
}

export default function BinaryBodyPanel() {
	const { request, updateField, resolveString } = useRequestBuilderContext();
	const variables = useVariableSupport();
	const file: FileRef = request.binaryFile ?? noFile();
	const { data: roots = [] } = useFileRootsQuery();
	const { chooseAndAllow, isPending: allowing } = useAllowFolder();
	const [dragging, setDragging] = useState(false);

	const setFile = useCallback((next: FileRef) => updateField("binaryFile", next), [updateField]);

	/*
	 * The Content-Type the user set is kept - a different file is not a reason
	 * to forget it - and the browser's own guess at a type is not written: the
	 * engine's extension table decides when the user did not, and it is the
	 * one that reaches the wire.
	 */
	const onPick = useCallback(
		(picked: PickedFile) => {
			const next: FileRef = {
				src: picked.src,
				fileName: picked.fileName,
				unresolved: flagAfterPick(picked.src),
			};
			if (file.contentType) next.contentType = file.contentType;
			setFile(next);
		},
		[file.contentType, setFile]
	);
	const { open, inputProps } = useFilePick(onPick);

	const onDrop = (event: DragEvent<HTMLDivElement>) => {
		event.preventDefault();
		setDragging(false);
		const dropped = event.dataTransfer.files?.[0];
		if (dropped) onPick(pickedFileOf(dropped));
	};

	// The declared name and the engine's answer belonged to the previous path,
	// so they go with it.
	const onTypePath = (src: string) => {
		const next: FileRef = { src };
		if (file.contentType) next.contentType = file.contentType;
		setFile(next);
	};

	const onContentType = (contentType: string) => {
		const next: FileRef = { ...file };
		if (contentType) next.contentType = contentType;
		else delete next.contentType;
		setFile(next);
	};

	const src = file.src ?? "";
	const templated = containsVariableToken(src);
	const resolvedPath = useResolvedPath(src, resolveString);
	const size = useFileSize(resolvedPath);
	const name = file.fileName?.trim() || fileBaseName(resolvedPath || src);
	const coveringRoot = resolvedPath
		? roots.find((root) => isUnderFolder(resolvedPath, root.path))
		: undefined;
	const hasPath = Boolean(src.trim());
	const notChosen = hasPath && !templated && isUnresolved(file.unresolved);
	const needsTrust = notChosen || (hasPath && templated);
	const contentType = binaryContentType(request.headers, file);

	return (
		<div className="flex flex-col gap-3">
			<input {...inputProps} />

			{/*
			 * The drop target. Dragging is a pointer-only gesture, so the
			 * keyboard path is the Choose file button inside it - which is why
			 * this box carries no role or key handler of its own.
			 */}
			<div
				data-testid="binary-drop-zone"
				onDragOver={(event) => {
					event.preventDefault();
					setDragging(true);
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={onDrop}
				className={cn(
					"flex items-center gap-3 rounded-md border border-dashed border-input px-3 py-3",
					dragging && "border-primary bg-primary/10"
				)}
			>
				<FileUp className="size-icon shrink-0 text-muted-foreground" aria-hidden="true" />
				<div className="min-w-0 flex-1">
					{src.trim() ? (
						<>
							<p className="truncate text-sm font-medium" title={resolvedPath || src}>
								{name || src}
							</p>
							<p className="text-xs text-muted-foreground">
								{templated && resolvedPath !== src && (
									<span className="font-mono">{resolvedPath} · </span>
								)}
								{size === null
									? templated && containsVariableToken(resolvedPath)
										? "A variable in this path has no value"
										: ""
									: "missing" in size
										? "Not found on this machine"
										: formatSize(size.size)}
							</p>
						</>
					) : (
						<p className="text-sm text-muted-foreground">
							Drop a file here, choose one, or type its path below.
						</p>
					)}
				</div>
				<Button type="button" variant="outline" size="sm" onClick={open}>
					{src.trim() ? "Replace file" : "Choose file"}
				</Button>
			</div>

			{needsTrust &&
				(coveringRoot ? (
					<Callout severity="info" positive>
						Under the allowed folder{" "}
						<span className="font-mono">{coveringRoot.path}</span> - this file is sent
						without picking it again.
					</Callout>
				) : (
					<Callout
						severity="warning"
						title={notChosen ? "Not chosen on this machine" : "Path has a variable"}
						action={
							<div className="flex items-center gap-1">
								{notChosen && (
									<Button type="button" size="sm" variant="ghost" onClick={open}>
										Relink
									</Button>
								)}
								{chooseAndAllow && (
									<Button
										type="button"
										size="sm"
										variant="ghost"
										onClick={() => void chooseAndAllow()}
										disabled={allowing}
									>
										Allow folder…
									</Button>
								)}
							</div>
						}
					>
						{notChosen
							? "A typed, imported or pasted path is sent only after you pick the file here or allow its folder in Settings › Files."
							: "A path built from a variable is sent only from a folder allowed in Settings › Files."}
					</Callout>
				))}

			<div className="space-y-1.5">
				<Label htmlFor="binary-body-path">Path</Label>
				<VariableInput
					id="binary-body-path"
					aria-label="File path"
					value={src}
					onChange={onTypePath}
					placeholder="/path/to/file.bin or {{fixturesDir}}/file.bin"
					variables={variables}
					size="sm"
					className="font-mono"
				/>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor="binary-body-content-type">Content-Type</Label>
				<VariableInput
					id="binary-body-content-type"
					aria-label="Content-Type"
					value={file.contentType ?? ""}
					onChange={onContentType}
					placeholder="From the file extension"
					variables={variables}
					size="sm"
					className="font-mono"
				/>
				<p className="text-xs text-muted-foreground">
					{contentType.from === "header" ? (
						<>
							Sent as <code className="font-mono">{contentType.value}</code> - the
							Content-Type header on the Headers tab wins over this field.
						</>
					) : contentType.from === "file" ? (
						<>
							Sent as <code className="font-mono">{contentType.value}</code>.
						</>
					) : (
						"Left empty, the type comes from the file extension, or application/octet-stream when the extension is not one Vayu knows."
					)}
				</p>
			</div>
		</div>
	);
}
