/**
 * VariableToken Component
 *
 * An inline styled span representing a {{variable}} that:
 * - Shows the variable name with highlighting
 * - Opens a popover on click to view/edit value
 * - Shows resolved value and scope
 */

import { useState, useEffect, useRef } from "react";
import { Popover, PopoverContent, PopoverTrigger, Badge, Input } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { VariableScope } from "../../types";

interface VariableTokenProps {
	name: string;
	value: string;
	scope: VariableScope;
	resolved: boolean;
	onValueChange?: (name: string, value: string, scope: VariableScope) => void;
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
	const [isOpen, setIsOpen] = useState(false);
	const [editValue, setEditValue] = useState(value);
	// Track the value that was set when popover opened to detect actual changes
	const openValueRef = useRef(value);

	// Keep editValue in sync with value prop when popover is closed
	// This ensures the edit field shows the correct value when opened
	useEffect(() => {
		if (!isOpen) {
			setEditValue(value);
		}
	}, [value, isOpen]);

	// Auto-save when value changes and popover closes
	const handleOpenChange = (open: boolean) => {
		if (open) {
			// Opening: initialize edit value from current prop value
			setEditValue(value);
			openValueRef.current = value;
		} else {
			// Closing: auto-save if value actually changed from when we opened
			// Compare against openValueRef to avoid saving unchanged values
			if (editValue !== openValueRef.current && onValueChange) {
				onValueChange(name, editValue, scope);
			}
		}
		setIsOpen(open);
	};

	const getScopeBadge = () => {
		const config: Record<VariableScope, { label: string; className: string }> = {
			global: {
				label: "Global",
				className: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
			},
			collection: {
				label: "Collection",
				className: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
			},
			environment: {
				label: "Environment",
				className: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
			},
		};
		const { label, className } = config[scope];
		return (
			<Badge variant="secondary" className={cn("text-[10px] px-1.5 py-0", className)}>
				{label}
			</Badge>
		);
	};

	return (
		<Popover open={isOpen} onOpenChange={handleOpenChange}>
			<PopoverTrigger asChild>
				<span
					className={cn(
						"inline cursor-pointer transition-colors rounded",
						resolved
							? "text-primary hover:bg-primary/20"
							: "text-destructive hover:bg-destructive/20",
						disabled && "cursor-default opacity-50"
					)}
					style={{
						// Use same monospace font as input for consistent character widths
						fontFamily:
							"ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
					}}
					onClick={(e) => {
						if (!disabled) {
							e.preventDefault();
							e.stopPropagation();
							setIsOpen(true);
						}
					}}
					contentEditable={false}
					suppressContentEditableWarning
				>
					{`{{${name}}}`}
				</span>
			</PopoverTrigger>
			<PopoverContent
				className="w-72 p-3"
				align="start"
				side="bottom"
				onOpenAutoFocus={(e) => e.preventDefault()}
			>
				<div className="space-y-3">
					<div className="flex items-center justify-between">
						<span className="font-mono text-sm font-medium">{name}</span>
						{getScopeBadge()}
					</div>

					{resolved ? (
						<>
							<div className="space-y-2">
								<label className="text-xs text-muted-foreground">
									Current Value
								</label>
								<div className="font-mono text-sm bg-muted px-2 py-1.5 rounded break-all">
									{value || (
										<span className="italic text-muted-foreground">empty</span>
									)}
								</div>
							</div>

							{onValueChange && (
								<div className="space-y-2">
									<label className="text-xs text-muted-foreground">
										Edit Value
									</label>
									<Input
										value={editValue}
										onChange={(e) => setEditValue(e.target.value)}
										onKeyDown={(e) => {
											e.stopPropagation();
											if (e.key === "Enter" || e.key === "Escape") {
												setIsOpen(false);
											}
										}}
										className="h-8 font-mono text-sm"
										autoFocus
									/>
									<p className="text-[10px] text-muted-foreground">
										Auto-saves when you click away
									</p>
								</div>
							)}
						</>
					) : (
						<div className="text-sm text-destructive">
							Variable not defined. Define it in Globals, an Environment, or
							Collection variables.
						</div>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}
