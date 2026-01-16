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
	CommandList,
	CommandEmpty,
	CommandGroup,
	CommandItem,
} from "./command";
import { TooltipProvider } from "./tooltip";
import { VariablePopover } from "./variable-popover";
import { VariableTooltip } from "./variable-tooltip";
import { VariableScopeBadge } from "./variable-scope-badge";
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
 * Uses centralized VariablePopover and VariableTooltip components
 */
interface VariableSegmentProps {
	varName: string;
	content: string;
	resolveVariable: (name: string) => VariableInfo | null;
	onUpdateVariable?: (name: string, value: string, scope: VariableScope) => void;
}

function VariableSegment({
	varName,
	content,
	resolveVariable,
	onUpdateVariable,
}: VariableSegmentProps) {
	const varInfo = resolveVariable(varName);
	const canEdit = !!onUpdateVariable && !!varInfo;

	// If we can edit, use popover with manual save mode
	if (canEdit && varInfo) {
		return (
			<VariablePopover
				name={varName}
				varInfo={varInfo}
				resolved={true}
				onValueChange={onUpdateVariable}
				saveMode="manual"
				showCurrentValue={false}
				trigger={content}
				triggerClassName="text-primary font-medium cursor-pointer hover:underline hover:bg-primary/10 rounded px-0.5 -mx-0.5"
			/>
		);
	}

	// Non-editable: use tooltip
	return (
		<VariableTooltip varName={varName} varInfo={varInfo} className="text-primary font-medium cursor-help">
			{content}
		</VariableTooltip>
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
	const inputRef = useRef<HTMLInputElement>(null);
	const isNavigatingRef = useRef(false);

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
								// When suggestions are open, handle navigation keys
								if (showSuggestions) {
									if (e.key === "ArrowDown" || e.key === "ArrowUp") {
										// Prevent input from handling these, let Command component handle navigation
										e.preventDefault();
										e.stopPropagation();
										// Mark that we're navigating to prevent blur from closing popover
										isNavigatingRef.current = true;
										// Keep input focused to prevent blur
										inputRef.current?.focus();
										// Dispatch the key event to the Command component
										const commandRoot = document.querySelector('[cmdk-root]') as HTMLElement;
										if (commandRoot) {
											// Create and dispatch the key event to the Command root
											const keyEvent = new KeyboardEvent("keydown", {
												key: e.key,
												bubbles: true,
												cancelable: true,
											});
											commandRoot.dispatchEvent(keyEvent);
										}
										// Reset navigation flag after a short delay
										setTimeout(() => {
											isNavigatingRef.current = false;
										}, 100);
										return;
									}
									if (e.key === "Enter") {
										// Enter should select the highlighted item in Command
										e.preventDefault();
										const highlightedItem = document.querySelector(
											'[cmdk-item][data-selected="true"]'
										) as HTMLElement;
										if (highlightedItem) {
											highlightedItem.click();
										}
										return;
									}
									if (e.key === "Escape") {
										e.preventDefault();
										setShowSuggestions(false);
										return;
									}
								}
							}}
							onBlur={(e) => {
								// Don't close if we're navigating with arrow keys
								if (isNavigatingRef.current) {
									return;
								}
								// Check if focus is moving to the popover
								const relatedTarget = e.relatedTarget as HTMLElement;
								if (relatedTarget?.closest('[cmdk-item]') || relatedTarget?.closest('[cmdk-list]')) {
									return;
								}
								// Delay to allow clicking on suggestions
								setTimeout(() => {
									if (!isNavigatingRef.current) {
										setShowSuggestions(false);
									}
								}, 150);
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
										<VariableScopeBadge scope={source.scope} variant="compact" />
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
