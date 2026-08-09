/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The value cell of a `form-data` row that carries a file.
 *
 * It replaces the row's `VariableInput` rather than sitting beside it: a file
 * part has no typed value, and offering a text field that is never sent is the
 * class of silent nothing this whole feature removes. What it shows instead is
 * the file the part will upload - its name, and its path in the tooltip, since
 * two `avatar.png` from different directories are not the same upload.
 *
 * **A path the app did not choose is marked.** An imported part carries the
 * path from whoever exported the collection, which usually does not exist on
 * this machine; the renderer cannot check (it has no filesystem access - the
 * engine reads the file, and refuses the request by name when it cannot). So
 * the row says the path is unverified until the user picks a file here, which
 * is the only event that proves it exists. See `FormFieldEntry.unresolved`.
 */

import { useRef } from "react";
import { FileUp, TriangleAlert } from "lucide-react";
import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui";
import { fileBaseName } from "@/lib/file-path";
import { cn } from "@/lib/utils";

export interface PickedFile {
	/** Absolute path, or "" outside Electron - the caller keeps the row unresolved then. */
	src: string;
	fileName: string;
	contentType: string;
}

/** The label on the button: what will be uploaded, in one line. */
function displayName(fileName: string | undefined, src: string | undefined): string {
	return fileName?.trim() || fileBaseName(src ?? "");
}

export default function FilePartCell({
	fileName,
	src,
	unresolved,
	disabled,
	onPick,
}: {
	fileName?: string;
	src?: string;
	unresolved?: boolean;
	disabled?: boolean;
	onPick: (file: PickedFile) => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const name = displayName(fileName, src);
	const chosen = Boolean(name);

	const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		// The same value twice in a row is not a change event, so clearing lets
		// the user re-pick the file they just replaced.
		event.target.value = "";
		if (!file) return;
		onPick({
			src: window.electronAPI?.getFilePath(file) ?? "",
			fileName: file.name,
			contentType: file.type,
		});
	};

	const label = chosen ? name : "Choose file";
	const button = (
		<Button
			type="button"
			variant="outline"
			size="sm"
			disabled={disabled}
			onClick={() => inputRef.current?.click()}
			aria-label={chosen ? `Replace file ${name}` : "Choose file"}
			className="h-8 w-full justify-start gap-1.5 rounded-md px-2 font-normal"
		>
			<FileUp className="h-3.5 w-3.5 shrink-0" />
			<span className={cn("truncate text-xs", !chosen && "text-muted-foreground")}>
				{label}
			</span>
			{unresolved && (
				<TriangleAlert
					className="ml-auto h-3.5 w-3.5 shrink-0 text-warning-text"
					aria-label="File path not verified on this machine"
				/>
			)}
		</Button>
	);

	return (
		<div className="min-w-0">
			<input
				ref={inputRef}
				type="file"
				className="hidden"
				onChange={handleChange}
				// Named so a screen reader announces the row this belongs to; the
				// visible control is the button above.
				aria-hidden="true"
				tabIndex={-1}
			/>
			<Tooltip>
				<TooltipTrigger asChild>{button}</TooltipTrigger>
				<TooltipContent side="left" className="max-w-md">
					<span className="font-mono break-all">
						{src?.trim() || "No file chosen - this part cannot be sent yet."}
					</span>
					{unresolved && (
						<span className="mt-1 block">
							This path came from the imported file and has not been verified on this
							machine. Choose the file to re-point it.
						</span>
					)}
				</TooltipContent>
			</Tooltip>
		</div>
	);
}
