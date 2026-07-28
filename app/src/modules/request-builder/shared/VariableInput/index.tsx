/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

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
import { VariableAutocomplete, SuggestionList } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useRequestBuilderContext } from "../../context/RequestBuilderContext";
import type { VariableScope } from "../../types";
import EditableVariable from "./EditableVariable";
import { VARIABLE_PATTERN } from "@/constants/variables";
import { variableCompletionContext } from "@/lib/variable-completion";

interface VariableInputProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	className?: string;
	disabled?: boolean;
	suggestions?: string[]; // Optional list of plain text suggestions (e.g., standard headers)
	onPaste?: (e: React.ClipboardEvent<HTMLInputElement>) => void; // Raw paste passthrough
	/**
	 * Names the field. Needed because the placeholder is dropped once the value
	 * contains a variable (it would show through the highlight overlay), and a
	 * placeholder was the only thing naming these inputs - so typing `{{x}}`
	 * silently left the field anonymous to a screen reader.
	 */
	"aria-label"?: string;
}

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
	onPaste,
	"aria-label": ariaLabel,
}: VariableInputProps) {
	const { getAllVariables, updateVariable } = useRequestBuilderContext();

	const [showSuggestions, setShowSuggestions] = useState(false);
	const [showPlainSuggestions, setShowPlainSuggestions] = useState(false);
	const [cursorPosition, setCursorPosition] = useState(0);
	const [searchQuery, setSearchQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const isNavigatingRef = useRef(false);

	const allVariables = getAllVariables();
	const segments = useMemo(() => parseSegments(value), [value]);
	const hasVariables = segments.some((s) => s.type === "variable");

	/*
	 * Check if we should show autocomplete.
	 *
	 * The "am I inside an open `{{`" rule is shared with the Monaco body editors
	 * via `variableCompletionContext`. It was written inline here - twice in this
	 * file, once for this check and once in `handleSelectVariable` below - which
	 * is a pair that drifts the moment either is touched.
	 */
	const checkForSuggestions = useCallback((inputValue: string, cursorPos: number) => {
		const context = variableCompletionContext(inputValue.slice(0, cursorPos));
		if (!context) {
			setShowSuggestions(false);
			return;
		}
		setSearchQuery(context.query);
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
		} else if (!showSuggestions) {
			setShowPlainSuggestions(false);
		}
	};

	const handleSelectVariable = (varName: string) => {
		// Same rule as `checkForSuggestions` above, from the same place - this
		// used to re-derive the open index with its own `lastIndexOf`, and the
		// two disagreed about a closed `{{name}}` earlier in the field.
		const context = variableCompletionContext(value.slice(0, cursorPosition));
		if (!context) return;

		const lastOpenIndex = context.openIndex;
		const afterCursor = value.slice(cursorPosition);
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

	// Convert variables to the format expected by VariableAutocomplete
	const variablesForAutocomplete = useMemo(() => {
		return Object.fromEntries(
			Object.entries(allVariables).map(([name, info]) => [
				name,
				{
					value: info.value,
					scope: info.scope as VariableScope,
				},
			])
		);
	}, [allVariables]);

	// Filter plain text suggestions based on current value
	const filteredSuggestions = useMemo(() => {
		if (suggestions.length === 0) return [];
		const lowerValue = value.toLowerCase();
		return suggestions.filter(
			(s) => s.toLowerCase().includes(lowerValue) && s.toLowerCase() !== lowerValue
		);
	}, [suggestions, value]);

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
		/*
		 * Plain suggestions are navigated by `cmdk` itself - see SuggestionList.
		 * This used to be ~30 lines of ArrowUp / ArrowDown / Enter / Tab / Escape
		 * handling against a `selectedSuggestionIndex` this component owned, a
		 * second implementation of what the Command primitive two branches down
		 * was already doing for variables.
		 *
		 * Only Escape stays here, because closing the list is this component's
		 * state rather than the list's.
		 */
		if (showPlainSuggestions && e.key === "Escape") {
			setShowPlainSuggestions(false);
			return;
		}

		// For variable suggestions, let VariableAutocomplete (Command) handle navigation
		if (showSuggestions) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				e.stopPropagation();
				// Mark that we're navigating to prevent blur from closing popover
				isNavigatingRef.current = true;
				// Keep input focused to prevent blur
				inputRef.current?.focus();
				// Forward the key event to the Command component
				const commandRoot = document.querySelector("[cmdk-root]") as HTMLElement;
				if (commandRoot) {
					const keyEvent = new KeyboardEvent("keydown", {
						key: e.key,
						bubbles: true,
						cancelable: true,
					});
					commandRoot.dispatchEvent(keyEvent);
				}
				setTimeout(() => {
					isNavigatingRef.current = false;
				}, 100);
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				// Command component will handle selection via onSelect
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
		if (relatedTarget?.closest("[cmdk-item]") || relatedTarget?.closest("[cmdk-list]")) {
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
						<EditableVariable
							name={seg.varName}
							value={varInfo?.value || ""}
							scope={varInfo?.scope || "global"}
							resolved={!!varInfo}
							// Both come from the resolver and were being dropped on
							// the floor here: `secret` is what stops the hover
							// tooltip printing a credential, and `sourceName` is
							// which environment the value came from.
							secret={varInfo?.secret}
							sourceName={varInfo?.sourceName}
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
			className={cn(
				// Default chrome - overridable via className. Wrapper owns border/bg/size
				// so the inner input can be borderless and fill it.
				"relative flex items-center h-9 w-full bg-background rounded-md border border-input px-3 text-sm font-mono shadow-sm transition-colors",
				"focus-within:outline-none focus-within:ring-1 focus-within:ring-ring",
				disabled && "opacity-50 cursor-not-allowed",
				className
			)}
			onClick={handleContainerClick}
		>
			{/* Input layer - receives text input. Borderless, fills the wrapper. */}
			<input
				ref={inputRef}
				type="text"
				value={value}
				onChange={handleChange}
				onPaste={onPaste}
				onKeyDown={handleKeyDown}
				onFocus={handleFocus}
				onBlur={handleBlur}
				placeholder={!hasVariables ? placeholder : undefined}
				// Falls back to the placeholder text so the field keeps a name
				// even when the placeholder itself is withheld above.
				aria-label={ariaLabel ?? placeholder}
				disabled={disabled}
				className={cn(
					"absolute inset-0 w-full h-full bg-transparent border-0 outline-none px-[inherit] font-[inherit] text-[inherit]",
					"placeholder:text-muted-foreground disabled:cursor-not-allowed",
					// When we have variables, hide real text so the overlay shows through
					hasVariables && "text-transparent caret-foreground selection:bg-primary/30"
				)}
				style={{ zIndex: 1 }}
			/>

			{/* Visual overlay layer for variable tokens - ON TOP of input for clickable tokens */}
			{hasVariables && (
				<div
					className="absolute inset-0 flex items-center px-[inherit] overflow-hidden"
					style={{
						zIndex: 2,
						pointerEvents: "none", // Pass clicks through to input
					}}
					aria-hidden="true"
				>
					<span className="whitespace-pre font-[inherit] text-[inherit]">
						{renderOverlayContent()}
					</span>
				</div>
			)}

			{/* Variable Autocomplete - Use Case 1: Select from list */}
			{showSuggestions && (
				<div className="absolute left-0 top-full mt-1 z-50">
					<VariableAutocomplete
						variables={variablesForAutocomplete}
						searchQuery={searchQuery}
						onSelect={handleSelectVariable}
					/>
				</div>
			)}

			{/* Plain Text Suggestions (e.g., for standard headers) */}
			{showPlainSuggestions && !showSuggestions && filteredSuggestions.length > 0 && (
				<div className="absolute left-0 top-full mt-1 z-50">
					<SuggestionList items={filteredSuggestions} onSelect={handleSelectSuggestion} />
				</div>
			)}
		</div>
	);
}
