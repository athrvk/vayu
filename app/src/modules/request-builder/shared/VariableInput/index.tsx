/**
 * VariableInput Component (Request Builder)
 *
 * Hybrid input with variable syntax support:
 * - Uses a hidden input for text entry
 * - Displays an overlay with clickable variable tokens
 * - Autocomplete dropdown when typing {{
 * - Click variables to open edit popover with current value
 */

import {
	useState,
	useRef,
	useCallback,
	useMemo,
	useEffect,
	type KeyboardEvent,
	type ChangeEvent,
} from "react";
import {
	Command,
	CommandList,
	CommandEmpty,
	CommandGroup,
	CommandItem,
	VariableScopeBadge,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { useRequestBuilderContext } from "../../context/RequestBuilderContext";
import type { VariableScope } from "../../types";
import VariableToken from "./VariableToken";

interface VariableInputProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	className?: string;
	disabled?: boolean;
	suggestions?: string[]; // Optional list of plain text suggestions (e.g., standard headers)
}

const VARIABLE_PATTERN = /\{\{([^{}]+)\}\}/g;

// Parse text into segments (text and variables)
function parseSegments(
	value: string
): Array<{ type: "text" | "variable"; content: string; varName?: string }> {
	const result: Array<{ type: "text" | "variable"; content: string; varName?: string }> = [];
	let lastIndex = 0;

	value.replace(VARIABLE_PATTERN, (match, varName, offset) => {
		if (offset > lastIndex) {
			result.push({
				type: "text",
				content: value.slice(lastIndex, offset),
			});
		}
		result.push({
			type: "variable",
			content: match,
			varName: varName.trim(),
		});
		lastIndex = offset + match.length;
		return match;
	});

	if (lastIndex < value.length) {
		result.push({
			type: "text",
			content: value.slice(lastIndex),
		});
	}

	return result;
}

export default function VariableInput({
	value,
	onChange,
	placeholder = "Enter value...",
	className,
	disabled = false,
	suggestions = [],
}: VariableInputProps) {
	const { getAllVariables, updateVariable } = useRequestBuilderContext();

	const [showSuggestions, setShowSuggestions] = useState(false);
	const [showPlainSuggestions, setShowPlainSuggestions] = useState(false);
	const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
	const [cursorPosition, setCursorPosition] = useState(0);
	const [searchQuery, setSearchQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const isNavigatingRef = useRef(false);

	const allVariables = getAllVariables();
	const segments = useMemo(() => parseSegments(value), [value]);
	const hasVariables = segments.some((s) => s.type === "variable");

	// Check if we should show autocomplete
	const checkForSuggestions = useCallback((inputValue: string, cursorPos: number) => {
		const beforeCursor = inputValue.slice(0, cursorPos);
		const lastOpenIndex = beforeCursor.lastIndexOf("{{");

		if (lastOpenIndex === -1) {
			setShowSuggestions(false);
			return;
		}

		const afterOpen = beforeCursor.slice(lastOpenIndex);
		if (afterOpen.includes("}}")) {
			setShowSuggestions(false);
			return;
		}

		const partialName = afterOpen.slice(2);
		setSearchQuery(partialName);
		setShowSuggestions(true);
		setShowPlainSuggestions(false);
	}, []);

	const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
		const newValue = e.target.value;
		const newCursorPos = e.target.selectionStart || 0;
		onChange(newValue);
		setCursorPosition(newCursorPos);
		checkForSuggestions(newValue, newCursorPos);

		// Show plain suggestions if we have them and not showing variable suggestions
		if (suggestions.length > 0 && !newValue.includes("{{")) {
			setShowPlainSuggestions(true);
			setSelectedSuggestionIndex(0);
		} else if (!showSuggestions) {
			setShowPlainSuggestions(false);
		}
	};

	const handleSelectVariable = (varName: string) => {
		const beforeCursor = value.slice(0, cursorPosition);
		const afterCursor = value.slice(cursorPosition);
		const lastOpenIndex = beforeCursor.lastIndexOf("{{");
		if (lastOpenIndex === -1) return;

		const beforeOpen = value.slice(0, lastOpenIndex);
		const newValue = `${beforeOpen}{{${varName}}}${afterCursor}`;
		onChange(newValue);
		setShowSuggestions(false);

		// Restore focus and set cursor after the inserted variable
		setTimeout(() => {
			inputRef.current?.focus();
			const newCursorPos = lastOpenIndex + varName.length + 4;
			inputRef.current?.setSelectionRange(newCursorPos, newCursorPos);
		}, 0);
	};

	const handleSelectSuggestion = (suggestion: string) => {
		onChange(suggestion);
		setShowPlainSuggestions(false);
		setTimeout(() => {
			inputRef.current?.focus();
			inputRef.current?.setSelectionRange(suggestion.length, suggestion.length);
		}, 0);
	};

	const filteredVariables = useMemo(() => {
		const entries = Object.entries(allVariables);
		if (!searchQuery) return entries;
		const lowerQuery = searchQuery.toLowerCase();
		return entries.filter(([name]) => name.toLowerCase().includes(lowerQuery));
	}, [allVariables, searchQuery]);

	// Filter plain text suggestions based on current value
	const filteredSuggestions = useMemo(() => {
		if (suggestions.length === 0) return [];
		const lowerValue = value.toLowerCase();
		return suggestions.filter(
			(s) => s.toLowerCase().includes(lowerValue) && s.toLowerCase() !== lowerValue
		);
	}, [suggestions, value]);

	// Reset selected index when filtered suggestions change
	useEffect(() => {
		setSelectedSuggestionIndex(0);
	}, [filteredSuggestions.length]);

	// Handle Escape key globally
	useEffect(() => {
		const handleEscapeKey = (e: globalThis.KeyboardEvent) => {
			if (e.key === "Escape") {
				setShowSuggestions(false);
				setShowPlainSuggestions(false);
			}
		};
		document.addEventListener("keydown", handleEscapeKey);
		return () => document.removeEventListener("keydown", handleEscapeKey);
	}, []);


	// Handle keyboard navigation
	const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		// Arrow key navigation for plain suggestions
		if (showPlainSuggestions && filteredSuggestions.length > 0) {
			const maxIndex = Math.min(filteredSuggestions.length, 10) - 1;

			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelectedSuggestionIndex((prev) => (prev < maxIndex ? prev + 1 : prev));
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelectedSuggestionIndex((prev) => (prev > 0 ? prev - 1 : 0));
				return;
			}
			if (e.key === "Enter") {
				e.preventDefault();
				const idx = Math.min(selectedSuggestionIndex, maxIndex);
				handleSelectSuggestion(filteredSuggestions[idx]);
				return;
			}
			if (e.key === "Tab") {
				e.preventDefault();
				const idx = Math.min(selectedSuggestionIndex, maxIndex);
				handleSelectSuggestion(filteredSuggestions[idx]);
				return;
			}
			if (e.key === "Escape") {
				setShowPlainSuggestions(false);
				return;
			}
		}

		// For variable suggestions, let Command component handle navigation
		// Just prevent input from handling arrow keys and forward them to Command
		if (showSuggestions && filteredVariables.length > 0) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				e.stopPropagation();
				// Mark that we're navigating to prevent blur from closing popover
				isNavigatingRef.current = true;
				// Keep input focused to prevent blur
				inputRef.current?.focus();
				// Forward the key event to the Command component
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
				e.preventDefault();
				// Command component will handle selection via onSelect
				// Trigger click on highlighted item
				const highlightedItem = document.querySelector(
					'[cmdk-item][data-selected="true"]'
				) as HTMLElement;
				if (highlightedItem) {
					highlightedItem.click();
				}
				return;
			}
			if (e.key === "Tab") {
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
				setShowSuggestions(false);
				return;
			}
		}
	};

	// Handle focus - show plain suggestions if available
	const handleFocus = () => {
		if (suggestions.length > 0 && !showSuggestions) {
			setShowPlainSuggestions(true);
			setSelectedSuggestionIndex(0);
		}
	};

	// Handle blur - hide suggestions
	const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
		// Don't close if we're navigating with arrow keys
		if (isNavigatingRef.current) {
			return;
		}
		// Check if focus is moving to the popover
		const relatedTarget = e.relatedTarget as HTMLElement;
		if (relatedTarget?.closest('[cmdk-item]') || relatedTarget?.closest('[cmdk-list]')) {
			return;
		}
		setTimeout(() => {
			if (!isNavigatingRef.current) {
				setShowSuggestions(false);
				setShowPlainSuggestions(false);
			}
		}, 200);
	};

	// Handle variable value change from token popover
	const handleVariableChange = (name: string, newValue: string, scope: VariableScope) => {
		updateVariable(name, newValue, scope);
	};

	// Focus the hidden input when clicking on the container (but not on variable tokens)
	const handleContainerClick = (e: React.MouseEvent) => {
		// Don't focus if clicking on a variable token (it has its own click handling)
		const target = e.target as HTMLElement;
		if (target.closest("[data-variable-token]")) {
			return;
		}
		inputRef.current?.focus();
	};

	// Render the overlay content with variable tokens
	const renderOverlayContent = () => {
		if (!value) return null;

		return segments.map((seg, i) => {
			if (seg.type === "variable" && seg.varName) {
				const varInfo = allVariables[seg.varName];
				return (
					<span
						key={`${i}-${seg.varName}`}
						data-variable-token
						style={{ pointerEvents: "auto" }} // Make variable tokens clickable
					>
						<VariableToken
							name={seg.varName}
							value={varInfo?.value || ""}
							scope={varInfo?.scope || "global"}
							resolved={!!varInfo}
							onValueChange={handleVariableChange}
							disabled={disabled}
						/>
					</span>
				);
			}
			// Render text segments - pointer-events: none so clicks pass through to input
			return (
				<span key={i} className="text-foreground">
					{seg.content}
				</span>
			);
		});
	};

	return (
		<div
			ref={containerRef}
			className={cn("relative", className)}
			onClick={handleContainerClick}
		>
			{/* Input layer - receives text input */}
			<input
				ref={inputRef}
				type="text"
				value={value}
				onChange={handleChange}
				onKeyDown={handleKeyDown}
				onFocus={handleFocus}
				onBlur={handleBlur}
				placeholder={!hasVariables ? placeholder : undefined}
				disabled={disabled}
				className={cn(
					// Match shadcn Input styling
					"flex h-9 w-full rounded-md border border-input px-3 py-1 text-sm shadow-sm transition-colors",
					"placeholder:text-muted-foreground",
					"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
					"disabled:cursor-not-allowed disabled:opacity-50",
					// When we have variables, make text and background transparent so overlay shows through
					hasVariables
						? "text-transparent caret-foreground selection:bg-primary/30 bg-transparent"
						: "bg-background"
				)}
				style={{
					position: "relative",
					zIndex: 1,
					// Use monospace font for consistent character widths with overlay
					fontFamily:
						"ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
				}}
			/>

			{/* Visual overlay layer for variable tokens - ON TOP of input for clickable tokens */}
			{hasVariables && (
				<div
					className="absolute inset-0 flex items-center px-3 overflow-hidden"
					style={{
						zIndex: 2,
						pointerEvents: "none", // Pass clicks through to input
					}}
					aria-hidden="true"
				>
					<span
						className="text-sm whitespace-pre"
						style={{
							// Use same monospace font as input for consistent character widths
							fontFamily:
								"ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
						}}
					>
						{renderOverlayContent()}
					</span>
				</div>
			)}

			{/* Variable Autocomplete Popover */}
			{showSuggestions && filteredVariables.length > 0 && (
				<div className="absolute left-0 top-full mt-1 z-50 w-64 rounded-md border bg-popover shadow-md">
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
				</div>
			)}

			{/* Plain Text Suggestions Popover (e.g., for standard headers) */}
			{showPlainSuggestions && !showSuggestions && filteredSuggestions.length > 0 && (
				<div className="absolute left-0 top-full mt-1 z-50 w-64 max-h-48 overflow-y-auto rounded-md border bg-popover shadow-md">
					{filteredSuggestions.slice(0, 10).map((suggestion, index) => (
						<button
							key={suggestion}
							type="button"
							className={cn(
								"w-full text-left px-3 py-2 text-sm cursor-pointer",
								index === selectedSuggestionIndex ? "bg-accent" : "hover:bg-accent"
							)}
							onMouseDown={(e) => {
								e.preventDefault();
								handleSelectSuggestion(suggestion);
							}}
							onMouseEnter={() => setSelectedSuggestionIndex(index)}
						>
							{suggestion}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
