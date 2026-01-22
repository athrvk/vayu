
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
					className="w-4 h-4 rounded border-input cursor-pointer disabled:opacity-50"
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
					<div className="truncate overflow-x-auto scrollbar-thin text-sm font-mono text-muted-foreground bg-muted/50 px-2 py-1.5 w-full h-9 flex items-center">
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
							<span className="italic text-muted-foreground/50">—</span>
						)}
					</div>
				</div>
			)}

			{/* Remove Button */}
			<Button
				size="icon"
				variant="ghost"
				onClick={() => onRemove(item.id)}
				disabled={isReadOnly || !canRemove}
				className={cn(
					"h-8 w-8 text-muted-foreground hover:text-destructive transition-opacity",
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
