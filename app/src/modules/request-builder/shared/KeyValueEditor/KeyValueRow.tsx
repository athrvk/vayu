/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * KeyValueRow Component
 *
 * Single row in the KeyValueEditor with variable support
 */

import { memo } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { KeyValueItem } from "../../types";
import { useRequestBuilderContext } from "../../context/RequestBuilderContext";
import VariableInput from "../VariableInput";

interface KeyValueRowProps {
	item: KeyValueItem;
	keyPlaceholder: string;
	valuePlaceholder: string;
	showResolved: boolean;
	allowDisable: boolean;
	readOnly: boolean;
	keySuggestions?: string[];
	onUpdate: (id: string, field: keyof KeyValueItem, value: string | boolean) => void;
	onRemove: (id: string) => void;
	canRemove?: boolean;
	canEdit?: boolean;
	canDisable?: boolean;
}

function KeyValueRow({
	item,
	keyPlaceholder,
	valuePlaceholder,
	showResolved,
	allowDisable,
	readOnly,
	keySuggestions,
	onUpdate,
	onRemove,
	canRemove = true,
	canEdit = true,
	canDisable = true,
}: KeyValueRowProps) {
	const { resolveString } = useRequestBuilderContext();

	const resolvedKey = resolveString(item.key);
	const resolvedValue = resolveString(item.value);
	const hasVariableInKey = item.key !== resolvedKey;
	const hasVariableInValue = item.value !== resolvedValue;

	const isProtected = !canEdit || !canRemove || !canDisable;
	const isReadOnly = readOnly || !canEdit;

	return (
		<div
			className={cn(
				"grid gap-2 items-center group p-1",
				showResolved
					? "grid-cols-[24px_1fr_1fr_1fr_32px]"
					: "grid-cols-[24px_1fr_1fr_32px]",
				!item.enabled && "opacity-50",
				isProtected && "bg-muted/30"
			)}
		>
			{/* Enable/Disable Checkbox */}
			{allowDisable ? (
				<input
					type="checkbox"
					checked={item.enabled}
					onChange={(e) => onUpdate(item.id, "enabled", e.target.checked)}
					disabled={isReadOnly || !canDisable}
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

			{/* Key Input */}
			<VariableInput
				value={item.key}
				onChange={(v) => onUpdate(item.id, "key", v)}
				placeholder={keyPlaceholder}
				disabled={isReadOnly || !item.enabled}
				suggestions={keySuggestions}
			/>

			{/* Value Input */}
			<VariableInput
				value={item.value}
				onChange={(v) => onUpdate(item.id, "value", v)}
				placeholder={valuePlaceholder}
				disabled={isReadOnly || !item.enabled}
			/>

			{/* Resolved Preview */}
			{showResolved && (
				<div className="flex items-center min-w-0">
					{/*
					 * `rounded-md`, so the preview follows Settings → Appearance →
					 * Roundedness like every other box. With no radius class at all it
					 * was pinned square at every setting - the same escape hatch as a
					 * bare `rounded`, in the other direction.
					 *
					 * `truncate` alone: it sets `overflow: hidden`, which the old
					 * `overflow-x-auto` beside it contradicted outright. Nothing
					 * scrolled; the ellipsis just fought a scrollbar that could not
					 * appear.
					 */}
					<div className="truncate rounded-md text-sm font-mono text-muted-foreground bg-muted/50 px-2 py-1.5 w-full h-9 flex items-center">
						{item.enabled && (resolvedKey || resolvedValue) ? (
							<>
								<span className={hasVariableInKey ? "text-primary" : ""}>
									{resolvedKey}
								</span>
								{resolvedKey && resolvedValue && <span>=</span>}
								<span className={hasVariableInValue ? "text-primary" : ""}>
									{resolvedValue}
								</span>
							</>
						) : (
							<span className="italic text-muted-foreground">-</span>
						)}
					</div>
				</div>
			)}

			{/* Remove Button */}
			<Button
				size="icon"
				variant="rowActionDestructive"
				onClick={() => onRemove(item.id)}
				disabled={isReadOnly || !canRemove}
				aria-label="Remove row"
				className={cn(
					// `focus-visible:opacity-100` is not decoration. The button was
					// revealed on hover only, so a keyboard user tabbing through a
					// headers table landed on a fully transparent control - including
					// its focus ring - once per row, and Enter there silently deleted
					// the row they could not see they were on.
					"h-8 w-8 transition-opacity focus-visible:opacity-100",
					!canRemove
						? "opacity-0 cursor-not-allowed"
						: "opacity-0 group-hover:opacity-100"
				)}
			>
				<Trash2 className="w-4 h-4" />
			</Button>
		</div>
	);
}

export default memo(KeyValueRow);
