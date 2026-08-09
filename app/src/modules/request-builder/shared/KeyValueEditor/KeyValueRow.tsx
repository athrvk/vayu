/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One row of the key/value table.
 *
 * `h-8` fields at a 36px pitch, down from `h-9` in a `p-1` row at 48px. This is
 * the densest table in the app and it was the loosest thing in the panel.
 *
 * The resolved value moved out of a column and into `ResolvedPeek` - see the
 * note there for why, and for how it stays out of the way of the variable
 * token's own popover.
 */

import { memo } from "react";
import { Trash2, Sigma, Paperclip, Type } from "lucide-react";
import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { KeyValueItem } from "../../types";
import { useRequestBuilderContext } from "../../context/RequestBuilderContext";
import VariableInput from "../VariableInput";
import FilePartCell, { type PickedFile } from "./FilePartCell";

interface KeyValueRowProps {
	item: KeyValueItem;
	keyPlaceholder: string;
	valuePlaceholder: string;
	showResolved: boolean;
	allowDisable: boolean;
	readOnly: boolean;
	keySuggestions?: string[];
	/** `form-data` only: rows may be switched between a text value and a file. */
	allowFiles?: boolean;
	onUpdate: (id: string, field: keyof KeyValueItem, value: string | boolean) => void;
	/** Sets the file members of one row together - a pick is one edit, not four. */
	onPickFile: (id: string, file: PickedFile) => void;
	onToggleKind: (id: string, kind: "text" | "file") => void;
	onRemove: (id: string) => void;
	canRemove?: boolean;
	/** Per field - see the note at the call site in KeyValueEditor. */
	canEditKey?: boolean;
	canEditValue?: boolean;
	canDisable?: boolean;
}

/**
 * The resolved form of a row that contains `{{variables}}`, on demand.
 *
 * It used to be a column holding an equal third of the table, printing
 * `key=value` - the two cells to its left, joined - on every row whether or not
 * anything in it resolved. Most rows have no variable, so most of that third
 * was an echo.
 *
 * **A marker rather than bare row-hover.** Hovering the row itself would fire
 * underneath the variable token's own tooltip, which already answers "what does
 * *this* variable resolve to" - two hover surfaces in one space, one of them
 * invisible. This is a separate target with its own column, so the two never
 * overlap: the token answers for itself, the marker answers for the whole line.
 *
 * It renders only where there is something to resolve, so the column is empty
 * on an ordinary row and the marker is its own affordance - the alternative was
 * a hover with nothing on screen to say it existed.
 */
function ResolvedPeek({ label, resolved }: { label: string; resolved: string }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={`Resolved value of ${label}`}
					className="flex h-8 w-5 items-center justify-center rounded-md text-subtle-foreground transition-colors hover:text-primary-text focus-visible:text-primary-text focus-visible:outline-none"
				>
					<Sigma className="h-3 w-3" />
				</button>
			</TooltipTrigger>
			<TooltipContent side="left" className="max-w-md">
				<span className="font-mono break-all">{resolved}</span>
			</TooltipContent>
		</Tooltip>
	);
}

function KeyValueRow({
	item,
	keyPlaceholder,
	valuePlaceholder,
	showResolved,
	allowDisable,
	readOnly,
	keySuggestions,
	allowFiles = false,
	onUpdate,
	onPickFile,
	onToggleKind,
	onRemove,
	canRemove = true,
	canEditKey = true,
	canEditValue = true,
	canDisable = true,
}: KeyValueRowProps) {
	const { resolveString } = useRequestBuilderContext();

	const resolvedKey = resolveString(item.key);
	const resolvedValue = resolveString(item.value);
	/*
	 * "Contains a variable" is exactly "resolving changed something". A row whose
	 * text is already literal has nothing to peek at, which is the condition the
	 * marker keys off.
	 */
	const hasVariables = item.key !== resolvedKey || item.value !== resolvedValue;

	const keyReadOnly = readOnly || !canEditKey;
	const valueReadOnly = readOnly || !canEditValue;
	const isProtected = !canEditKey || !canEditValue || !canRemove || !canDisable;
	// A row is a file part only where files are offered: a stored `type: "file"`
	// on a urlencoded row (which the engine refuses) must not paint a picker
	// that cannot be sent.
	const isFileRow = allowFiles && item.type === "file";

	return (
		<div
			className={cn(
				"grid gap-2 items-center group px-1 py-0.5 rounded-md",
				allowFiles
					? "grid-cols-[24px_1fr_1fr_20px_20px_28px]"
					: "grid-cols-[24px_1fr_1fr_20px_28px]",
				!item.enabled && "opacity-50",
				isProtected && "bg-muted/30"
			)}
		>
			{allowDisable ? (
				<input
					type="checkbox"
					checked={item.enabled}
					onChange={(e) => onUpdate(item.id, "enabled", e.target.checked)}
					disabled={keyReadOnly || !canDisable}
					// Named after the row it governs. Without this it announced as
					// a bare "checkbox", giving no clue which row it enables - and
					// there is one per row.
					aria-label={item.key ? `Enable ${item.key}` : "Enable this row"}
					// `accent-primary` paints the native control in the user's accent.
					// Without it the browser default wins - a fixed blue that ignores
					// both the theme and the accent scheme, in the densest table in
					// the app. The variables table already does this with
					// `accent-scope-*`; this one had been left on the browser blue.
					// The neighbouring `rounded-md` / `border-input` are inert on a
					// native checkbox (no `appearance-none`), so `accent-color` is the
					// only property here that actually paints.
					className="w-4 h-4 accent-primary cursor-pointer disabled:opacity-50"
				/>
			) : (
				<div className="w-4" />
			)}

			<VariableInput
				value={item.key}
				onChange={(v) => onUpdate(item.id, "key", v)}
				placeholder={keyPlaceholder}
				disabled={keyReadOnly || !item.enabled}
				suggestions={keySuggestions}
				className="h-8"
			/>

			{isFileRow ? (
				<FilePartCell
					fileName={item.fileName}
					src={item.src}
					unresolved={item.unresolved}
					disabled={valueReadOnly || !item.enabled}
					onPick={(file) => onPickFile(item.id, file)}
				/>
			) : (
				<VariableInput
					value={item.value}
					onChange={(v) => onUpdate(item.id, "value", v)}
					placeholder={valuePlaceholder}
					disabled={valueReadOnly || !item.enabled}
					className="h-8"
				/>
			)}

			{/*
			 * The kind switch, in its own column so it never takes the resolved
			 * marker's place - a form-data row can hold `{{vars}}` and want both.
			 * Only `form-data` gets this column at all (`allowFiles`): headers,
			 * params and urlencoded have no file form on the wire.
			 */}
			{allowFiles && (
				<div className="flex items-center justify-center">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								size="icon"
								variant="ghost"
								onClick={() => onToggleKind(item.id, isFileRow ? "text" : "file")}
								disabled={valueReadOnly || !item.enabled}
								aria-label={
									isFileRow
										? `Send ${item.key || "this part"} as text`
										: `Send ${item.key || "this part"} as a file`
								}
								className="h-6 w-5 rounded-md text-subtle-foreground hover:text-primary-text"
							>
								{isFileRow ? (
									<Type className="h-3 w-3" />
								) : (
									<Paperclip className="h-3 w-3" />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent side="left">
							{isFileRow ? "Send as text instead" : "Send a file instead"}
						</TooltipContent>
					</Tooltip>
				</div>
			)}

			{/* Empty on an ordinary row; the column keeps the grid aligned. */}
			<div className="flex items-center justify-center">
				{showResolved && item.enabled && hasVariables && !isFileRow && (
					<ResolvedPeek
						label={item.key || "this row"}
						resolved={resolvedValue ? `${resolvedKey}: ${resolvedValue}` : resolvedKey}
					/>
				)}
			</div>

			<Button
				size="icon"
				variant="rowActionDestructive"
				onClick={() => onRemove(item.id)}
				disabled={keyReadOnly || !canRemove}
				aria-label="Remove row"
				className={cn(
					// `focus-visible:opacity-100` is not decoration. The button was
					// revealed on hover only, so a keyboard user tabbing through a
					// headers table landed on a fully transparent control - including
					// its focus ring - once per row, and Enter there silently deleted
					// the row they could not see they were on.
					"h-7 w-7 transition-opacity focus-visible:opacity-100",
					!canRemove
						? "opacity-0 cursor-not-allowed"
						: "opacity-0 group-hover:opacity-100"
				)}
			>
				<Trash2 className="w-3.5 h-3.5" />
			</Button>
		</div>
	);
}

export default memo(KeyValueRow);
