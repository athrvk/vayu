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
				<span
					style={{
						// Use same monospace font as input for consistent character widths
						fontFamily:
							"ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
					}}
					contentEditable={false}
					suppressContentEditableWarning
				>
					{`{{${name}}}`}
				</span>
			}
			triggerClassName={cn(
				"inline cursor-pointer transition-colors rounded",
				resolved
					? "text-primary hover:bg-primary/20"
					: "text-destructive hover:bg-destructive/20",
				disabled && "cursor-default opacity-50"
			)}
		/>
	);
}
