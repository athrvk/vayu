/**
 * VariableToken Component
 *
 * An inline styled span representing a {{variable}} that:
 * - Shows the variable name with highlighting
 * - Opens a popover on click to view/edit value
 * - Shows resolved value and scope
 *
 * Uses the centralized VariablePopover component.
 */

import { VariablePopover, type VariableScope } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { VariableScope as RequestBuilderVariableScope } from "../../types";

interface VariableTokenProps {
	name: string;
	value: string;
	scope: RequestBuilderVariableScope;
	resolved: boolean;
	onValueChange?: (name: string, value: string, scope: RequestBuilderVariableScope) => void;
	disabled?: boolean;
}

export default function VariableToken({
	name,
	value,
	scope,
	resolved,
	onValueChange,
	disabled = false,
}: VariableTokenProps) {
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
