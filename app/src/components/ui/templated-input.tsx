/**
 * TemplatedInput Component
 *
 * A generic text input that supports {{variable}} template syntax with:
 * - Syntax highlighting (primary color for variables)
 * - Autocomplete suggestions when typing {{
 * - Hover preview showing resolved values
 * - Click to edit variable values inline (like Postman)
 * - Visual scope indicators (G=Global, C=Collection, E=Environment)
 *
 * This is a reusable input component that can be used anywhere template
 * variables are needed (URL bar, request headers, body, etc.)
 */

import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import {
	Command,
	CommandInput,
	CommandList,
	CommandEmpty,
	CommandGroup,
	CommandItem,
} from "./command";
import { Badge } from "./badge";
import { Button } from "./button";
import { Input } from "./input";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "./tooltip";
import { cn } from "@/lib/utils";

export type VariableScope = "global" | "collection" | "environment";

export interface VariableInfo {
	value: string;
	scope: VariableScope;
}

export interface TemplatedInputProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	className?: string;
	disabled?: boolean;
	/**
	 * Function that returns all available variables as a Record<name, VariableInfo>
	 */
	getVariables: () => Record<string, VariableInfo>;
	/**
	 * Function that resolves a single variable by name
	 */
	resolveVariable: (name: string) => VariableInfo | null;
	/**
	 * Optional callback to update a variable's value inline
	 * If provided, clicking on a variable will show an edit popover
	 */
	onUpdateVariable?: (name: string, value: string, scope: VariableScope) => void;
}

const VARIABLE_PATTERN = /\{\{([^{}]+)\}\}/g;

/**
 * VariableSegment - Renders a single {{variable}} with tooltip and optional edit popover
 */
interface VariableSegmentProps {
	varName: string;
	content: string;
	resolveVariable: (name: string) => VariableInfo | null;
	onUpdateVariable?: (name: string, value: string, scope: VariableScope) => void;
	editingVariable: { name: string; value: string; scope: VariableScope } | null;
	setEditingVariable: (v: { name: string; value: string; scope: VariableScope } | null) => void;
	editValue: string;
	setEditValue: (v: string) => void;
	getScopeBadge: (scope: VariableScope) => React.ReactNode;
}

function VariableSegment({
	varName,
	content,
	resolveVariable,
	onUpdateVariable,
	editingVariable,
	setEditingVariable,
	editValue,
	setEditValue,
	getScopeBadge,
}: VariableSegmentProps) {
	const varInfo = resolveVariable(varName);
	const isEditing = editingVariable?.name === varName;
	const canEdit = !!onUpdateVariable && !!varInfo;

	const handleOpenEditPopover = (e: React.MouseEvent) => {
		if (!canEdit || !varInfo) return;
		e.stopPropagation();
		e.preventDefault();
		setEditingVariable({ name: varName, value: varInfo.value, scope: varInfo.scope });
		setEditValue(varInfo.value);
	};

	const handleSaveEdit = () => {
		if (editingVariable && onUpdateVariable) {
			onUpdateVariable(editingVariable.name, editValue, editingVariable.scope);
		}
		setEditingVariable(null);
	};

	const handleCancelEdit = () => {
		setEditingVariable(null);
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			handleSaveEdit();
		} else if (e.key === "Escape") {
			handleCancelEdit();
		}
	};

	// If we can edit and have the popover, show it
	if (canEdit) {
		return (
			<Popover open={isEditing} onOpenChange={(open) => !open && setEditingVariable(null)}>
				<PopoverTrigger asChild>
					<span
						className="text-primary font-medium cursor-pointer hover:underline hover:bg-primary/10 rounded px-0.5 -mx-0.5"
						onClick={handleOpenEditPopover}
					>
						{content}
					</span>
				</PopoverTrigger>
				<PopoverContent
					className="w-72 p-3"
					align="start"
					onClick={(e) => e.stopPropagation()}
					onPointerDownOutside={(e) => e.preventDefault()}
				>
					<div className="space-y-3">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<span className="font-mono text-sm font-medium">{varName}</span>
								{getScopeBadge(editingVariable?.scope || varInfo.scope)}
							</div>
						</div>
						<div className="space-y-2">
							<label className="text-xs text-muted-foreground">Value</label>
							<Input
								value={editValue}
								onChange={(e) => setEditValue(e.target.value)}
								onKeyDown={handleKeyDown}
								className="h-8 font-mono text-sm"
								autoFocus
							/>
						</div>
						<div className="flex justify-end gap-2">
							<Button size="sm" variant="ghost" onClick={handleCancelEdit}>
								Cancel
							</Button>
							<Button size="sm" onClick={handleSaveEdit}>
								Save
							</Button>
						</div>
						<p className="text-xs text-muted-foreground">
							Press Enter to save, Esc to cancel
						</p>
					</div>
				</PopoverContent>
			</Popover>
		);
	}

	// Non-editable: just show tooltip
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className="text-primary font-medium cursor-help">{content}</span>
			</TooltipTrigger>
			<TooltipContent>
				{varInfo ? (
					<div className="text-xs">
						<div className="font-medium">{varName}</div>
						<div className="text-muted-foreground">= {varInfo.value}</div>
						<div className="text-muted-foreground mt-1">Scope: {varInfo.scope}</div>
					</div>
				) : (
					<div className="text-xs text-destructive">Unresolved variable</div>
				)}
			</TooltipContent>
		</Tooltip>
	);
}

export function TemplatedInput({
	value,
	onChange,
	placeholder = "Enter value...",
	className,
	disabled = false,
	getVariables,
	resolveVariable,
	onUpdateVariable,
}: TemplatedInputProps) {
	const [showSuggestions, setShowSuggestions] = useState(false);
	const [cursorPosition, setCursorPosition] = useState(0);
	const [searchQuery, setSearchQuery] = useState("");
	const [editingVariable, setEditingVariable] = useState<{
		name: string;
		value: string;
		scope: VariableScope;
	} | null>(null);
	const [editValue, setEditValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	const allVariables = getVariables();

	// Parse text into segments (text and variables)
	const segments = useMemo(() => {
		const result: Array<{ type: "text" | "variable"; content: string; varName?: string }> = [];
		let lastIndex = 0;

		value.replace(VARIABLE_PATTERN, (match, varName, offset) => {
			// Add text before this variable
			if (offset > lastIndex) {
				result.push({ type: "text", content: value.slice(lastIndex, offset) });
			}
			// Add the variable
			result.push({ type: "variable", content: match, varName: varName.trim() });
			lastIndex = offset + match.length;
			return match;
		});

		// Add remaining text
		if (lastIndex < value.length) {
			result.push({ type: "text", content: value.slice(lastIndex) });
		}

		return result;
	}, [value]);

	// Check if we should show suggestions (cursor is after {{ )
	const checkForSuggestions = useCallback((inputValue: string, cursorPos: number) => {
		// Find the last {{ before cursor
		const beforeCursor = inputValue.slice(0, cursorPos);
		const lastOpenIndex = beforeCursor.lastIndexOf("{{");

		if (lastOpenIndex === -1) {
			setShowSuggestions(false);
			return;
		}

		// Check if there's a closing }} after the {{
		const afterOpen = beforeCursor.slice(lastOpenIndex);
		if (afterOpen.includes("}}")) {
			setShowSuggestions(false);
			return;
		}

		// Extract the partial variable name being typed
		const partialName = afterOpen.slice(2); // Remove {{
		setSearchQuery(partialName);
		setShowSuggestions(true);
	}, []);

	// Handle input change
	const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const newValue = e.target.value;
		const newCursorPos = e.target.selectionStart || 0;
		onChange(newValue);
		setCursorPosition(newCursorPos);
		checkForSuggestions(newValue, newCursorPos);
	};

	// Handle variable selection from autocomplete
	const handleSelectVariable = (varName: string) => {
		const beforeCursor = value.slice(0, cursorPosition);
		const afterCursor = value.slice(cursorPosition);

		// Find the {{ we need to complete
		const lastOpenIndex = beforeCursor.lastIndexOf("{{");
		if (lastOpenIndex === -1) return;

		// Build the new value
		const beforeOpen = value.slice(0, lastOpenIndex);
		const newValue = `${beforeOpen}{{${varName}}}${afterCursor}`;
		onChange(newValue);
		setShowSuggestions(false);

		// Focus back on input
		setTimeout(() => {
			inputRef.current?.focus();
			const newCursorPos = lastOpenIndex + varName.length + 4; // {{ + name + }}
			inputRef.current?.setSelectionRange(newCursorPos, newCursorPos);
		}, 0);
	};

	// Filter variables based on search query
	const filteredVariables = useMemo(() => {
		const entries = Object.entries(allVariables);
		if (!searchQuery) return entries;
		const lowerQuery = searchQuery.toLowerCase();
		return entries.filter(([name]) => name.toLowerCase().includes(lowerQuery));
	}, [allVariables, searchQuery]);

	// Close suggestions on escape or click outside
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setShowSuggestions(false);
			}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, []);

	// Get scope badge color
	const getScopeBadge = (scope: VariableScope) => {
		switch (scope) {
			case "global":
				return (
					<Badge
						variant="outline"
						className="h-5 px-1.5 text-[10px] font-medium bg-muted"
					>
						G
					</Badge>
				);
			case "collection":
				return (
					<Badge
						variant="outline"
						className="h-5 px-1.5 text-[10px] font-medium bg-blue-50 text-blue-700 border-blue-200"
					>
						C
					</Badge>
				);
			case "environment":
				return (
					<Badge
						variant="outline"
						className="h-5 px-1.5 text-[10px] font-medium bg-green-50 text-green-700 border-green-200"
					>
						E
					</Badge>
				);
		}
	};

	return (
		<TooltipProvider>
			<Popover open={showSuggestions} onOpenChange={setShowSuggestions}>
				<PopoverTrigger asChild>
					<div className={cn("relative", className)}>
						{/* Hidden actual input for editing */}
						<input
							ref={inputRef}
							type="text"
							value={value}
							onChange={handleChange}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									setShowSuggestions(false);
								}
							}}
							onBlur={() => {
								// Delay to allow clicking on suggestions
								setTimeout(() => setShowSuggestions(false), 150);
							}}
							placeholder={placeholder}
							disabled={disabled}
							className="absolute inset-0 w-full h-full bg-transparent cursor-text z-10 text-transparent caret-foreground selection:bg-primary/30"
						/>
						{/* Visible styled overlay */}
						<div
							className={cn(
								"flex items-center w-full h-9 px-3 py-2 text-sm rounded-md border border-input bg-background",
								"focus-within:ring-1 focus-within:ring-ring",
								disabled && "opacity-50 cursor-not-allowed",
								!value && "text-muted-foreground"
							)}
							onClick={() => inputRef.current?.focus()}
						>
							{value ? (
								<span className="truncate">
									{segments.map((seg, i) =>
										seg.type === "variable" ? (
											<VariableSegment
												key={i}
												varName={seg.varName!}
												content={seg.content}
												resolveVariable={resolveVariable}
												onUpdateVariable={onUpdateVariable}
												editingVariable={editingVariable}
												setEditingVariable={setEditingVariable}
												editValue={editValue}
												setEditValue={setEditValue}
												getScopeBadge={getScopeBadge}
											/>
										) : (
											<span key={i}>{seg.content}</span>
										)
									)}
								</span>
							) : (
								<span>{placeholder}</span>
							)}
						</div>
					</div>
				</PopoverTrigger>

				<PopoverContent
					className="w-64 p-0"
					align="start"
					onOpenAutoFocus={(e) => e.preventDefault()}
				>
					<Command shouldFilter={false}>
						<CommandInput
							placeholder="Search variables..."
							value={searchQuery}
							onValueChange={setSearchQuery}
							className="h-9"
						/>
						<CommandList>
							<CommandEmpty>No variables found.</CommandEmpty>
							<CommandGroup heading="Variables">
								{filteredVariables.map(([name, source]) => (
									<CommandItem
										key={name}
										value={name}
										onSelect={() => handleSelectVariable(name)}
										className="flex items-center justify-between cursor-pointer"
									>
										<span className="font-mono text-sm">{name}</span>
										{getScopeBadge(source.scope)}
									</CommandItem>
								))}
							</CommandGroup>
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>
		</TooltipProvider>
	);
}
