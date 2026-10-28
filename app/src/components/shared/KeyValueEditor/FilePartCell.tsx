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
 * **A path nobody picked here is marked.** An imported or pasted part carries
 * the path from whoever wrote it, which usually does not exist on this
 * machine, and the engine sends it only once it is picked here or lies under
 * an allowed folder. The mark reads the engine's answer (`unresolved`, derived
 * on every read) and, before one arrives, treats the path as not chosen; a
 * pick clears it (`lib/file-trust.ts`).
 */

import { FileUp, Pencil, TriangleAlert } from "lucide-react";
import {
	Button,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui";
import type { VariableSupport } from "@/types";
import VariableInput from "../VariableInput";
import { fileBaseName } from "@/lib/file-path";
import { isUnresolved } from "@/lib/file-trust";
import { cn } from "@/lib/utils";
import { useFilePick, type PickedFile } from "../file-pick";

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
	partName,
	onRename,
	variables,
}: {
	fileName?: string;
	src?: string;
	unresolved?: boolean;
	disabled?: boolean;
	onPick: (file: PickedFile) => void;
	/** The part's key, for the rename control's label. */
	partName?: string;
	/** Sets the name the file is sent under; empty clears it. Omitted: no control. */
	onRename?: (name: string) => void;
	variables?: VariableSupport;
}) {
	const { open, inputProps } = useFilePick(onPick);
	const name = displayName(fileName, src);
	const chosen = Boolean(name);
	// A part that names nothing has no path to doubt - it reads "Choose file",
	// like a row turned into a file part by hand - whatever its flag says.
	const unverified = isUnresolved(unresolved) && chosen;

	const label = chosen ? name : "Choose file";
	const button = (
		<Button
			type="button"
			variant="outline"
			size="sm"
			disabled={disabled}
			onClick={open}
			aria-label={chosen ? `Replace file ${name}` : "Choose file"}
			className="h-control-sm w-full justify-start gap-1.5 rounded-md px-2 font-normal"
		>
			<FileUp className="size-icon-sm shrink-0" />
			<span className={cn("truncate text-xs", !chosen && "text-muted-foreground")}>
				{label}
			</span>
			{unverified && (
				<TriangleAlert
					className="ml-auto size-icon-sm shrink-0 text-warning-text"
					aria-label="File path not verified on this machine"
				/>
			)}
		</Button>
	);

	const ownName = fileBaseName(src ?? "");

	return (
		<div className="flex min-w-0 items-center gap-1">
			<input {...inputProps} />
			<Tooltip>
				<TooltipTrigger asChild>{button}</TooltipTrigger>
				<TooltipContent side="left" className="max-w-md">
					<span className="font-mono break-all">
						{src?.trim() || "No file chosen - this part can't be sent yet."}
					</span>
					{unverified && (
						<span className="mt-1 block">
							This path was not chosen on this machine and has not been verified here.
							Choose the file to re-point it.
						</span>
					)}
				</TooltipContent>
			</Tooltip>
			{onRename && chosen && (
				<Popover>
					<Tooltip>
						<TooltipTrigger asChild>
							<PopoverTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									disabled={disabled}
									aria-label={`Name the upload of ${partName || "this part"}`}
									className="size-control-sm shrink-0"
								>
									<Pencil className="size-icon-sm" />
								</Button>
							</PopoverTrigger>
						</TooltipTrigger>
						<TooltipContent>Send the file under another name</TooltipContent>
					</Tooltip>
					<PopoverContent align="end" className="space-y-2">
						<VariableInput
							value={fileName ?? ""}
							onChange={onRename}
							placeholder={ownName}
							variables={variables}
							size="sm"
							aria-label="File name sent in the part"
						/>
						<p className="text-label text-muted-foreground">
							Empty sends the file&apos;s own name.
						</p>
					</PopoverContent>
				</Popover>
			)}
		</div>
	);
}
