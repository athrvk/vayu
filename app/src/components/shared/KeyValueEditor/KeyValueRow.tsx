/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One row of the key/value table.
 *
 * `size="sm"` fields (`control-sm`) at a 36px pitch, down from `h-9` in a `p-1`
 * row at 48px. This is the densest table in the app and it was the loosest
 * thing in the panel.
 *
 * The resolved value moved out of a column and into `ResolvedPeek` - see the
 * note there for why, and for how it stays out of the way of the variable
 * token's own popover.
 *
 * Resolution comes from the optional `variables` prop. With none the row is
 * still a row: plain fields, no marker, no tokens. See `VariableSupport`.
 */

import { memo } from "react";
import { Trash2, Sigma, Paperclip, Type } from "lucide-react";
import {
	Button,
	Checkbox,
	ICON_MOTION,
	IconSwap,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
	TooltipValue,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { createStableResolve } from "@/lib/dynamic-variable-cache";
import { refusalsText, type BoundField, type DataFieldContext } from "@/lib/data-bind-escaping";
import { isBlankRow } from "./key-value";
import { keyValueGrid } from "./grid";
import type { KeyValueItem, KeyValueRowExtra, VariableSupport } from "@/types";
import VariableInput from "../VariableInput";
import { TimeMarker } from "../TimeValue";
import FilePartCell from "./FilePartCell";
import type { PickedFile } from "../file-pick";

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
	/** The caller's own control for this row (`KeyValueEditorProps.rowExtra`). */
	renderExtra?: KeyValueRowExtra["render"];
	/** The variable scope this row edits inside, or none. See `VariableSupport`. */
	variables?: VariableSupport;
	/** What kind of field the row's key and value are, for a picked row's bind. */
	fieldContext?: DataFieldContext;
	onUpdate: (id: string, field: keyof KeyValueItem, value: string | boolean) => void;
	/** Sets the file members of one row together - a pick is one edit, not four. */
	onPickFile: (id: string, file: PickedFile) => void;
	onToggleKind: (id: string, kind: "text" | "file") => void;
	/** Backs `renderExtra`'s `replaceItem`; only a table that passes `renderExtra` needs it. */
	onReplaceItem?: (id: string, next: KeyValueItem) => void;
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
 *
 * What it shows is the row's resolved text as the row itself computed it
 * (`stableRowField` below), not a resolution of its own: "peek" promises the
 * value this row stands for, and opening it twice without editing anything has
 * to answer the same thing both times.
 *
 * **A secret variable's value is hidden here** (#1810), by `mask` applied to
 * the text drawn and to nothing else: the cached resolution and `hasVariables`
 * keep the real value, so the row's identity is unchanged and only the pixels
 * differ. The trigger's name is `label`, the row's *unresolved* key, so it
 * carries a variable's name and never its value.
 *
 * **A row the send would refuse says so here** (issue #2639): a picked row's
 * cell with a line break, bound into a header, previews as its token with the
 * reason beneath it. A refusal names the token and never the cell.
 */
function ResolvedPeek({
	label,
	resolved,
	refusals,
	mask,
}: {
	label: string;
	resolved: string;
	refusals: string[];
	mask?: (text: string) => string;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					size="icon"
					variant="ghost"
					aria-label={`Resolved value of ${label}`}
					className="rounded-md text-subtle-foreground hover:text-primary-text"
				>
					<Sigma className="size-icon-sm" />
				</Button>
			</TooltipTrigger>
			<TooltipContent side="left" className="max-w-md">
				<TooltipValue
					className="font-mono"
					hint={refusals.length > 0 ? refusalsText(refusals) : undefined}
				>
					{mask ? mask(resolved) : resolved}
				</TooltipValue>
			</TooltipContent>
		</Tooltip>
	);
}

/*
 * One entry per row *field* - `<row id>:key` and `<row id>:value` - cached
 * across this row's own unmount.
 *
 * A `useMemo` cannot hold this and a memo per row cannot even be written: the
 * row is one component rendered per item, so the memo would die with the row,
 * and Params, Headers, form-data and urlencoded all live behind a
 * `TabsContent` that Radix unmounts when you look at another tab
 * (`RequestTabs/index.tsx` force-mounts Body and Elements only). Without this,
 * a `{{$randomInt}}` in a value rerolled on every render the row took *and*
 * every round trip through another tab, so the Σ peek answered with a
 * different number each time it was opened, beside a "Sends" line one tab over
 * that is stable.
 *
 * The resolver outliving the row is what makes the cache reachable: it arrives
 * as `variables.resolveField`, which the request builder's provider owns
 * (`useVariableSupport`), so it is the same function on the way back in. Row
 * ids come from `toKeyValueItems` at the point the request is fetched, one
 * level above every panel, so they survive the same unmount. See
 * `lib/dynamic-variable-cache.ts` for why this is module scope and keyed by
 * id rather than by the text.
 */
const stableRowField = createStableResolve<BoundField>();

type ResolveField = VariableSupport["resolveField"];

/*
 * `resolveField` with the table's field context fixed, one function per pair:
 * `stableRowField` checks its resolver by identity, so a closure built in render
 * would miss on every render and reroll a `{{$randomInt}}`.
 */
const contextResolvers = new WeakMap<
	ResolveField,
	Map<DataFieldContext, (input: string) => BoundField>
>();
function resolverFor(
	resolveField: ResolveField,
	context: DataFieldContext
): (input: string) => BoundField {
	let byContext = contextResolvers.get(resolveField);
	if (!byContext) {
		byContext = new Map();
		contextResolvers.set(resolveField, byContext);
	}
	let resolve = byContext.get(context);
	if (!resolve) {
		resolve = (input) => resolveField(input, context);
		byContext.set(context, resolve);
	}
	return resolve;
}

/** A field read with no variable scope: its own text, nothing refused. */
const asTyped = (text: string): BoundField => ({ text, refusals: [] });

function KeyValueRow({
	item,
	keyPlaceholder,
	valuePlaceholder,
	showResolved,
	allowDisable,
	readOnly,
	keySuggestions,
	allowFiles = false,
	renderExtra,
	variables,
	fieldContext = "plain",
	onUpdate,
	onPickFile,
	onToggleKind,
	onReplaceItem,
	onRemove,
	canRemove = true,
	canEditKey = true,
	canEditValue = true,
	canDisable = true,
}: KeyValueRowProps) {
	const resolve = variables && resolverFor(variables.resolveField, fieldContext);
	const key = resolve ? stableRowField(`${item.id}:key`, item.key, resolve) : asTyped(item.key);
	const value = resolve
		? stableRowField(`${item.id}:value`, item.value, resolve)
		: asTyped(item.value);
	const resolvedKey = key.text;
	const resolvedValue = value.text;
	const refusals = [...key.refusals, ...value.refusals];
	/*
	 * "Contains a variable" is exactly "resolving changed something". A row whose
	 * text is already literal has nothing to peek at, which is the condition the
	 * marker keys off - and with no scope nothing resolves, so a table outside
	 * the request builder shows no marker at all rather than an empty one. A
	 * refused token previews as itself, so a refusal opens the peek on its own.
	 */
	const hasVariables =
		item.key !== resolvedKey || item.value !== resolvedValue || refusals.length > 0;

	const keyReadOnly = readOnly || !canEditKey;
	const valueReadOnly = readOnly || !canEditValue;
	const isProtected = !canEditKey || !canEditValue || !canRemove || !canDisable;
	// A row is a file part only where files are offered: a stored `type: "file"`
	// on a urlencoded row (which the engine refuses) must not paint a picker
	// that cannot be sent.
	const isFileRow = allowFiles && item.type === "file";
	// The trailing spare row every table keeps (`withTrailingBlank`), read with
	// the same predicate that decides it is spare rather than a second rule.
	const isPlaceholderRow = isBlankRow(item);

	return (
		<div
			className={cn(
				"grid gap-2 items-center group px-1 py-0.5 rounded-md",
				keyValueGrid(allowFiles, renderExtra !== undefined),
				!item.enabled && "opacity-50",
				isProtected && "bg-muted/30"
			)}
		>
			{/*
			 * The trailing spare row has no checkbox at all (#1691).
			 *
			 * It used to paint a *checked* accent box, so the row that exists only
			 * as somewhere to type read as an enabled parameter before anything had
			 * been typed into it - three enabled-looking params on a request that
			 * sends one. Rendering it unchecked instead would have been worse: the
			 * box is bound to `item.enabled`, which is `true`, so clicking it would
			 * have done nothing visible. The spacer keeps the column's width, so
			 * nothing shifts when the first character arrives and the real control
			 * takes its place.
			 */}
			{allowDisable && !isPlaceholderRow ? (
				<Checkbox
					checked={item.enabled}
					onChange={(e) => onUpdate(item.id, "enabled", e.target.checked)}
					// Its own gate, not the key's: a path-variable row (#1764) takes
					// its key from the URL yet is still the user's to switch off.
					disabled={readOnly || !canDisable}
					// Named after the row it governs. Without this it announced as
					// a bare "checkbox", giving no clue which row it enables - and
					// there is one per row.
					aria-label={item.key ? `Enable ${item.key}` : "Enable this row"}
					// `size-target` (issue #1679), not `size-icon`: this box is its own
					// hit target, with no separate padding wrapper the way a close
					// button's icon-in-a-bigger-box is - a native checkbox's rendered
					// box and its clickable area are the same box, so it takes the
					// interactive floor directly rather than the icon step.
					className="size-target"
				/>
			) : (
				<div className="size-target" />
			)}

			<VariableInput
				value={item.key}
				onChange={(v) => onUpdate(item.id, "key", v)}
				placeholder={keyPlaceholder}
				disabled={keyReadOnly || !item.enabled}
				suggestions={keySuggestions}
				variables={variables}
				size="sm"
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
					variables={variables}
					size="sm"
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
								className="size-target rounded-md text-subtle-foreground hover:text-primary-text"
							>
								<IconSwap
									state={isFileRow ? "file" : "text"}
									icons={{
										text: <Paperclip className="size-icon-sm" />,
										file: <Type className="size-icon-sm" />,
									}}
								/>
							</Button>
						</TooltipTrigger>
						<TooltipContent side="left">
							{isFileRow ? "Send as text instead" : "Send a file instead"}
						</TooltipContent>
					</Tooltip>
				</div>
			)}

			{/*
			 * The caller's control, in the column the table opened for it. Not on
			 * the trailing spare row: a blank row is dropped on save, so a choice
			 * made there would be lost, and the cell keeps the column's width the
			 * way the checkbox's spacer does.
			 */}
			{renderExtra && (
				<div className="flex items-center">
					{isPlaceholderRow
						? null
						: renderExtra(item, {
								replaceItem: (next) => onReplaceItem?.(item.id, next),
								disabled: readOnly || !canEditValue || !item.enabled,
							})}
				</div>
			)}

			{/*
			 * Empty on an ordinary row; the column keeps the grid aligned. A row
			 * with something to resolve gets the resolved peek; a literal value
			 * that is a time (`If-Modified-Since`, an `expires` param) gets the
			 * time card's marker (#1786). A literal time holds no `{{`, so the two
			 * only meet on a row whose key is a variable, and the peek wins.
			 */}
			<div className="flex items-center justify-center">
				{isFileRow ? null : showResolved && item.enabled && hasVariables ? (
					<ResolvedPeek
						label={item.key || "this row"}
						resolved={resolvedValue ? `${resolvedKey}: ${resolvedValue}` : resolvedKey}
						refusals={refusals}
						mask={variables?.maskSecrets}
					/>
				) : (
					<TimeMarker value={item.value} label={item.key || "This value"} />
				)}
			</div>

			{/*
			 * A row the caller says cannot be removed (a path variable, #1764,
			 * which goes when its URL segment does) gets no button at all, only
			 * the column's width. `opacity-0` on a disabled button did not hide
			 * it: the variant's `disabled:opacity-50` wins, so every such row
			 * showed a greyed trash can that did nothing.
			 */}
			{canRemove ? (
				<Button
					size="icon"
					variant="rowActionDestructive"
					onClick={() => onRemove(item.id)}
					disabled={keyReadOnly}
					aria-label="Remove row"
					// `focus-visible:opacity-100` is not decoration. The button was
					// revealed on hover only, so a keyboard user tabbing through a
					// headers table landed on a fully transparent control - including
					// its focus ring - once per row, and Enter there silently deleted
					// the row they could not see they were on.
					className="size-target opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
				>
					<Trash2 className="size-icon-sm" data-icon-motion={ICON_MOTION.lid} />
				</Button>
			) : (
				<div className="size-target" />
			)}
		</div>
	);
}

export default memo(KeyValueRow);
