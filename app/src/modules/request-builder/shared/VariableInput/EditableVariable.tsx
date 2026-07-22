/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * EditableVariable Component
 *
 * Use Case 2: Display a clickable variable token that opens a popover to view/edit
 * - Shows the variable name with syntax highlighting ({{variable}})
 * - Opens VariablePopover on click to view/edit the variable value
 * - Shows visual feedback (color) based on whether variable is resolved
 *
 * This is a wrapper around VariablePopover for inline variable display in inputs.
 */

import { VariablePopover, type VariableScope } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { VariableScope as RequestBuilderVariableScope } from "../../types";

export interface EditableVariableProps {
	/** Variable name */
	name: string;
	/** Variable value */
	value: string;
	/** Variable scope */
	scope: RequestBuilderVariableScope;
	/** Whether the variable is resolved (exists) */
	resolved: boolean;
	/** Callback when variable value changes */
	onValueChange?: (name: string, value: string, scope: RequestBuilderVariableScope) => void;
	/** Whether editing is disabled */
	disabled?: boolean;
}

export default function EditableVariable({
	name,
	value,
	scope,
	resolved,
	onValueChange,
	disabled = false,
}: EditableVariableProps) {
	const varInfo = resolved
		? {
				value,
				scope: scope as VariableScope,
			}
		: null;

	const handleValueChange = onValueChange
		? (varName: string, varValue: string, varScope: VariableScope) => {
				onValueChange(varName, varValue, varScope as RequestBuilderVariableScope);
			}
		: undefined;

	return (
		<VariablePopover
			name={name}
			varInfo={varInfo}
			resolved={resolved}
			onValueChange={handleValueChange}
			saveMode="auto"
			disabled={disabled}
			showCurrentValue={true}
			trigger={
				/*
				 * `font-[inherit]`, matching the plain-text segments beside it.
				 *
				 * This used to hardcode `ui-monospace, SFMono-Regular, 'SF Mono',
				 * Menlo, Consolas, 'Liberation Mono', monospace` under a comment
				 * saying "same monospace font as input for consistent character
				 * widths" - and that stack does not contain the app's mono font.
				 * `--font-mono` is `"JetBrains Mono", "Consolas", "Monaco",
				 * monospace`, so a variable token rendered in a different typeface
				 * from the text either side of it.
				 *
				 * That matters beyond looks. `VariableInput` paints this overlay on
				 * top of a transparent <input>, and the caret the user steers by
				 * belongs to the input. Any width difference between the two fonts
				 * walks the caret away from the glyphs it appears to sit between -
				 * which is exactly the drift the comment was trying to prevent.
				 */
				<span
					className="font-[inherit]"
					contentEditable={false}
					suppressContentEditableWarning
				>
					{`{{${name}}}`}
				</span>
			}
			triggerClassName={cn(
				"inline cursor-pointer transition-colors rounded-md",
				!resolved
					? "text-destructive-text hover:bg-destructive-text/10"
					: !value
						? "text-muted-foreground hover:bg-muted"
						: "text-primary hover:bg-primary/10",
				disabled && "cursor-default opacity-50"
			)}
		/>
	);
}
