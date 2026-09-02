/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * VariableInput Component
 *
 * Shared rather than request-builder-local because every `KeyValueRow` renders
 * one: a table under `components/shared/` reaching into a feature module for
 * its cell input is the same layering inversion the table's own move fixed
 * (#567).
 *
 * Hybrid input with variable syntax support:
 * - Uses a hidden input for text entry
 * - Displays an overlay with clickable variable tokens
 * - Autocomplete dropdown when typing {{
 * - Click variables to open edit popover with current value
 *
 * What a `{{token}}` *is* is not decided here: `classifyVariableToken`
 * (`@/lib/variable-token-kind`) owns that ladder for every surface that paints
 * one, this overlay and the Monaco decorations alike (issues #1220, #1239).
 * So a bare `{{name}}` that names a declared data column and that no scope
 * defines paints as a bound-column run-time token rather than an undefined
 * variable (issue #1007), and `{{$vu}}` / `{{$iteration}}` paint as run-time
 * tokens (issue #1101) - both because the classifier says so, in the order
 * `resolveTemplate` resolves them. This file decides only what each answer
 * looks like.
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
	VariableAutocomplete,
	SuggestionList,
	SUGGESTION_LIST_LIMIT,
	type CommandListboxState,
} from "@/components/ui";
import { buildVariableSuggestions, variableSuggestionKey } from "@/lib/variable-suggestions";
import { isCommitEnter } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import type { ResolvedVariable, VariableScope, VariableSupport } from "@/types";
import EditableVariable from "./EditableVariable";
import RuntimeToken from "./RuntimeToken";
import { VARIABLE_PATTERN } from "@/constants/variables";
import { variableCompletionContext } from "@/lib/variable-completion";
import { classifyVariableToken, type VariableTokenKind } from "@/lib/variable-token-kind";

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
	/**
	 * The field's element id, for the rare caller something outside its subtree
	 * has to reach - the Shell's ⌘L focuses the URL field this way, having no
	 * ref into the request builder. From `constants/dom-ids.ts`, both ends.
	 */
	id?: string;
	/**
	 * The variable scope this field edits inside. Omitted where there is none,
	 * which makes this a plain text field: no tokens, no `{{` autocomplete, no
	 * edit popover. See `VariableSupport`.
	 */
	variables?: VariableSupport;
}

/** Stable identity for the no-scope case, so the memos below do not re-run. */
const NO_VARIABLES: Record<string, ResolvedVariable> = {};

/**
 * One `{{token}}` the strip paints: what the name addresses, and where its text
 * sits in `value`.
 *
 * Decided before the paint rather than inside it (issue #1239), which is what
 * lets the strip count its own stops without reading the DOM it just rendered.
 */
interface OverlayToken {
	/** The name as written inside the braces. */
	name: string;
	/** What that name is, from the one ladder every token surface reads. */
	kind: VariableTokenKind;
	/**
	 * The token's own span of `value`, as the attributes a click reads back -
	 * see `placeCaretAtTokenEdge`.
	 */
	bounds: { "data-token-start": number; "data-token-end": number };
}

/**
 * The tokens the roving strip walks, in painted order.
 *
 * Whatever inside a token's wrapper carries a `tabindex`, rather than the
 * `[role="button"]` this matched while only editable tokens were focusable
 * (issue #1238). The two kinds do not share a role and must not: the editable
 * token's trigger is a `role="button"` that opens a popover, and a run-time
 * token's is deliberately none, because nothing about it is activated. What
 * they do share is being a stop, which is the thing the strip is enumerating.
 */
const TOKEN_STOPS = "[data-variable-token] [tabindex]";

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
	id,
	variables,
}: VariableInputProps) {
	const [showSuggestions, setShowSuggestions] = useState(false);
	const [showPlainSuggestions, setShowPlainSuggestions] = useState(false);
	const [cursorPosition, setCursorPosition] = useState(0);
	const [searchQuery, setSearchQuery] = useState("");
	/**
	 * The highlighted row, as a `cmdk` item value: a `variableSuggestionKey` for
	 * the variable list, the item's own text for the plain one. Held here rather
	 * than in the list because the arrow keys arrive at the input - see
	 * `handleKeyDown`.
	 */
	const [highlightedValue, setHighlightedValue] = useState("");
	/** Which token of the strip holds the single Tab stop - see the overlay. */
	const [activeTokenIndex, setActiveTokenIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const overlayRef = useRef<HTMLDivElement>(null);

	const allVariables = variables ? variables.getAllVariables() : NO_VARIABLES;
	const segments = useMemo(() => parseSegments(value), [value]);
	/*
	 * With no scope, `{{name}}` is just text: the overlay would paint a token
	 * claiming the name is undefined, and clicking it would open an editor with
	 * nowhere to write. The literal the user typed is the honest thing to show.
	 */
	const hasVariables = Boolean(variables) && segments.some((s) => s.type === "variable");

	/**
	 * The tokens the strip paints, in painted order, each already classified.
	 *
	 * The five ordered checks are `classifyVariableToken`'s - the same ladder the
	 * Monaco decorations read, rather than a second copy of it written here
	 * (issue #1239). Two copies would answer one `{{name}}` differently, and the
	 * same name would read as a bound column in the URL field and an undefined
	 * variable in the body beneath it.
	 *
	 * The offsets are accumulated over every segment, tokens and the text between
	 * them alike, because the segments tile the whole string - so a token's bounds
	 * are exact and a click can put the caret back beside it.
	 */
	const overlayTokens = useMemo(() => {
		const tokens: OverlayToken[] = [];
		let offset = 0;
		for (const seg of segments) {
			const start = offset;
			offset += seg.content.length;
			if (seg.type !== "variable" || !seg.varName) continue;
			tokens.push({
				name: seg.varName,
				kind: classifyVariableToken(seg.varName, {
					variables: allVariables,
					dataColumns: variables?.dataColumns,
				}),
				bounds: { "data-token-start": start, "data-token-end": offset },
			});
		}
		return tokens;
	}, [segments, allVariables, variables?.dataColumns]);

	/**
	 * Which token of the strip holds the Tab stop, as the strip stands now.
	 *
	 * Derived rather than corrected in an effect: editing the field re-paints the
	 * strip, and the token that held the stop may be gone - a stop past the end
	 * falls back to the first token, in the same render rather than one later.
	 * The count comes from `overlayTokens`, so nothing here reads back the DOM it
	 * has just painted to learn how many tokens it painted.
	 *
	 * The fallback is a fallback and not a reset: `activeTokenIndex` still holds
	 * the token the reader last put focus on, so a stop that comes back into
	 * range - retype three variables, delete two, type them again - is theirs
	 * again rather than the first token's. That is the roving-tabindex rule the
	 * rest of the app follows; the effect this replaced could not, having only
	 * the state itself to write its correction to.
	 */
	const activeStop = activeTokenIndex < overlayTokens.length ? activeTokenIndex : 0;

	/*
	 * Check if we should show autocomplete.
	 *
	 * The "am I inside an open `{{`" rule is shared with the Monaco body editors
	 * via `variableCompletionContext`. It was written inline here - twice in this
	 * file, once for this check and once in `handleSelectVariable` below - which
	 * is a pair that drifts the moment either is touched.
	 */
	const checkForSuggestions = useCallback(
		(inputValue: string, cursorPos: number) => {
			// Nothing to complete from without a scope.
			const context = variables
				? variableCompletionContext(inputValue.slice(0, cursorPos))
				: null;
			if (!context) {
				setShowSuggestions(false);
				return;
			}
			setSearchQuery(context.query);
			setShowSuggestions(true);
			setShowPlainSuggestions(false);
		},
		[variables]
	);

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
		return suggestions
			.filter((s) => s.toLowerCase().includes(lowerValue) && s.toLowerCase() !== lowerValue)
			.slice(0, SUGGESTION_LIST_LIMIT);
	}, [suggestions, value]);

	/*
	 * The variable rows, in the order they are drawn.
	 *
	 * Built here as well as inside `VariableAutocomplete` - from the same
	 * function, so it is one ordering read twice rather than two orderings - so
	 * that "the next row" is answerable without touching the DOM. It used to be
	 * answered by dispatching a synthetic keydown at
	 * `document.querySelector("[cmdk-root]")`, which is the first `cmdk` list in
	 * the *document*: with a second one mounted earlier, the arrows steered a
	 * list belonging to another field and Enter picked out of it (issue #1215).
	 */
	const variableSuggestions = useMemo(
		() =>
			showSuggestions
				? buildVariableSuggestions({
						variables: variablesForAutocomplete,
						searchQuery,
						dataColumns: variables?.dataColumns,
					})
				: [],
		[showSuggestions, variablesForAutocomplete, searchQuery, variables?.dataColumns]
	);

	/*
	 * Which list is on screen, and what it holds.
	 *
	 * `showSuggestions` alone is not it: the `{{` context can be open while
	 * nothing matches, and then no list renders. The combobox has to say
	 * `aria-expanded="false"` in that state, and Enter has to fall through to
	 * whatever the field's Enter normally does.
	 */
	/**
	 * Whether this field can ever pop a list up at all. Without a scope and
	 * without plain suggestions it is an ordinary text box, and should say so.
	 */
	const isCombobox = Boolean(variables) || suggestions.length > 0;

	const variableListOpen = showSuggestions && variableSuggestions.length > 0;
	const plainListOpen =
		!showSuggestions && showPlainSuggestions && filteredSuggestions.length > 0;
	const listOpen = variableListOpen || plainListOpen;

	const listValues = useMemo(
		() =>
			variableListOpen
				? variableSuggestions.map(variableSuggestionKey)
				: plainListOpen
					? filteredSuggestions
					: [],
		[variableListOpen, variableSuggestions, plainListOpen, filteredSuggestions]
	);

	/*
	 * Derived rather than corrected in an effect: the rows change on every
	 * keystroke, and a highlight that survives one render past its row would
	 * leave Enter inserting a name the list no longer offers.
	 */
	const activeValue = listValues.includes(highlightedValue)
		? highlightedValue
		: (listValues[0] ?? "");

	/**
	 * The ids the combobox has to name, reported by the list itself.
	 *
	 * `cmdk` mints them - it writes `id` after the props it is handed, so neither
	 * can be passed in - and `CommandListboxProbe` reads them from inside the
	 * list rather than from the document. Which list this input steers is the
	 * whole of issue #1215, and a `document.querySelector` is how it was lost.
	 */
	const [listboxIds, setListboxIds] = useState<CommandListboxState>({});
	const handleListboxState = useCallback((next: CommandListboxState) => {
		setListboxIds((prev) =>
			prev.listboxId === next.listboxId && prev.activeOptionId === next.activeOptionId
				? prev
				: next
		);
	}, []);

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

	/**
	 * Move the highlight without moving focus.
	 *
	 * Clamped rather than wrapped, which is what `cmdk` does with its default
	 * `loop={false}` - the list this replaced was `cmdk`'s own handler reached
	 * through a synthetic event, so wrapping here would be a behaviour change
	 * smuggled in with a bug fix.
	 */
	const moveHighlight = (delta: number) => {
		if (listValues.length === 0) return;
		const current = listValues.indexOf(activeValue);
		const next = Math.min(Math.max(current + delta, 0), listValues.length - 1);
		setHighlightedValue(listValues[next]);
	};

	/** Take the highlighted row. False when there is nothing to take. */
	const commitHighlight = () => {
		if (!activeValue) return false;
		if (variableListOpen) {
			const picked = variableSuggestions.find(
				(s) => variableSuggestionKey(s) === activeValue
			);
			if (!picked) return false;
			handleSelectVariable(picked.name);
			return true;
		}
		handleSelectSuggestion(activeValue);
		return true;
	};

	// Handle keyboard navigation
	const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		/*
		 * Escape closes whichever list is open, and closing is this component's
		 * state rather than the list's - so it is handled even when the list holds
		 * nothing to navigate.
		 */
		if (e.key === "Escape") {
			setShowSuggestions(false);
			setShowPlainSuggestions(false);
			return;
		}

		if (!listOpen) return;

		/*
		 * Both lists are navigated from here, because in both the keys arrive at
		 * this input: `cmdk` reads arrows off its own `Command.Input`, which
		 * neither list renders. Nothing about focus moves - the highlight is
		 * `activeValue`, handed back down as the list's controlled value.
		 */
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			e.stopPropagation();
			moveHighlight(e.key === "ArrowDown" ? 1 : -1);
			return;
		}

		// `isCommitEnter`, not a bare Enter: an IME commits its composition buffer
		// with one, and ⌘/Ctrl+Enter is the app's Send chord (#935, #939).
		if (isCommitEnter(e) || e.key === "Tab") {
			if (commitHighlight()) e.preventDefault();
		}
	};

	/**
	 * Arrow between the `{{tokens}}` painted over the field.
	 *
	 * The strip is one Tab stop, not one per token: a URL with five variables
	 * otherwise put five stops between the URL and Send. This is the roving
	 * tabindex `docs/design-system.md` describes for the collection tree, in the
	 * one shape a tree hook cannot serve - `useRovingTreeFocus` navigates
	 * `[role="treeitem"]` and dispatches at the tree's own data attributes, so
	 * pointing it at tokens would silently do nothing.
	 *
	 * Deliberately no wrap: arrowing off the end should not cycle, it should
	 * leave the reader at the edge with Tab as the way out.
	 */
	const handleOverlayKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const tokens = Array.from(
			overlayRef.current?.querySelectorAll<HTMLElement>(TOKEN_STOPS) ?? []
		);
		const current = tokens.indexOf(document.activeElement as HTMLElement);
		if (current === -1) return;

		const next =
			e.key === "ArrowRight"
				? current + 1
				: e.key === "ArrowLeft"
					? current - 1
					: e.key === "Home"
						? 0
						: e.key === "End"
							? tokens.length - 1
							: -1;
		if (next < 0 || next >= tokens.length || next === current) return;

		e.preventDefault();
		e.stopPropagation();
		setActiveTokenIndex(next);
		tokens[next].focus();
	};

	/** Whichever token took focus owns the Tab stop from now on. */
	const handleOverlayFocus = (e: React.FocusEvent<HTMLDivElement>) => {
		const tokens = Array.from(
			overlayRef.current?.querySelectorAll<HTMLElement>(TOKEN_STOPS) ?? []
		);
		const index = tokens.indexOf(e.target as HTMLElement);
		if (index !== -1) setActiveTokenIndex(index);
	};

	// Handle focus - show plain suggestions if available
	const handleFocus = () => {
		if (suggestions.length > 0 && !showSuggestions) {
			setShowPlainSuggestions(true);
		}
	};

	/*
	 * Handle blur - hide suggestions.
	 *
	 * The `isNavigatingRef` latch this used to carry is gone with the synthetic
	 * keydown that needed it: arrowing the list no longer touches focus at all,
	 * so there is no self-inflicted blur left to suppress.
	 */
	const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
		// Check if focus is moving to the popover
		const relatedTarget = e.relatedTarget as HTMLElement;
		if (relatedTarget?.closest("[cmdk-item]") || relatedTarget?.closest("[cmdk-list]")) {
			return;
		}
		setTimeout(() => {
			setShowSuggestions(false);
			setShowPlainSuggestions(false);
		}, 200);
	};

	// Handle variable value change from token popover
	const handleVariableChange = (name: string, newValue: string, scope: VariableScope) => {
		// Only reachable from a token, and a token only renders with a scope.
		variables?.updateVariable(name, newValue, scope);
	};

	/**
	 * Put the caret at the near edge of a token that took the click.
	 *
	 * A run-time token has to receive pointer events for its tooltip to open at
	 * all (issue #604), which means the click no longer reaches the transparent
	 * input underneath and the browser cannot place the caret from it. The token
	 * carries the offsets of its own text in `value`, so the near edge is
	 * recoverable: the half of the token that was clicked decides which side of
	 * it the caret lands on.
	 *
	 * The edges rather than an offset *within* the token, because there is no
	 * position inside `{{data.email}}` that means anything - it is one atom to
	 * everything that reads it, and dropping the caret between its braces is how
	 * a keystroke corrupts the name.
	 */
	const placeCaretAtTokenEdge = (token: HTMLElement, clientX: number) => {
		const input = inputRef.current;
		const start = Number(token.dataset.tokenStart);
		const end = Number(token.dataset.tokenEnd);
		if (!input || !Number.isFinite(start) || !Number.isFinite(end)) return;

		const rect = token.getBoundingClientRect();
		const caret = clientX < rect.left + rect.width / 2 ? start : end;
		input.focus();
		input.setSelectionRange(caret, caret);
		setCursorPosition(caret);
	};

	// Focus the hidden input when clicking on the container (but not on variable tokens)
	const handleContainerClick = (e: React.MouseEvent) => {
		const target = e.target as HTMLElement;
		/*
		 * A run-time token has no popover - a tooltip is the whole of it - so it
		 * must not swallow the click the way an editable token does. Before
		 * issue #604 it did neither: the overlay's `pointer-events: none` meant
		 * the token never saw a pointer event, so the tooltip could not open,
		 * and the early return below meant that once events were enabled the
		 * click would land nowhere. The fix is the pair.
		 */
		const runtime = target.closest<HTMLElement>("[data-runtime-token]");
		if (runtime) {
			placeCaretAtTokenEdge(runtime, e.clientX);
			return;
		}
		// Don't focus if clicking on a variable token (it has its own click handling)
		if (target.closest("[data-variable-token]")) {
			return;
		}
		inputRef.current?.focus();
	};

	/**
	 * Paint what `overlayTokens` decided, and nothing else.
	 *
	 * Two shapes rather than five (issue #1239): every run-time case - a `data.*`
	 * column, an identity name, a bare bound column, a generator - is one
	 * `RuntimeToken`, because they differ only in the words of the tooltip and
	 * the tone. Which of the two a name takes is `classifyVariableToken`'s answer,
	 * read above; the ordering that produces it is documented there.
	 */
	const renderOverlayContent = () => {
		if (!value) return null;

		/*
		 * Position of the next token in the strip. Every token counts, both kinds
		 * (issue #1238): a run-time token opens no popover, but its tooltip is the
		 * whole of what it has to say, so it is a stop like any other.
		 *
		 * `overlayTokens` holds one entry per variable segment, in this order and
		 * on this same condition, so the position is also the index into it.
		 */
		let position = 0;

		return segments.map((seg, i) => {
			if (seg.type === "variable" && seg.varName) {
				const { name, kind, bounds } = overlayTokens[position];
				/** The stop this token holds; exactly one of them is `0`. */
				const tabIndex = position++ === activeStop ? 0 : -1;
				const key = `${i}-${name}`;

				if (kind.state === "runtime") {
					return (
						<span
							key={key}
							data-variable-token
							data-runtime-token
							{...bounds}
							// The tooltip is this token's entire content, and a
							// tooltip opens on a pointer event the overlay's
							// `pointer-events: none` never delivered (issue #604).
							style={{ pointerEvents: "auto" }}
						>
							<RuntimeToken
								name={name}
								description={kind.description}
								note={kind.note}
								tone={kind.tone}
								tabIndex={tabIndex}
								disabled={disabled}
							/>
						</span>
					);
				}

				const varInfo = kind.info;
				return (
					<span
						key={key}
						data-variable-token
						style={{ pointerEvents: "auto" }} // Make variable tokens clickable
					>
						<EditableVariable
							// One Tab stop for the whole strip; the arrows move
							// between tokens - `handleOverlayKeyDown`.
							tabIndex={tabIndex}
							name={name}
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
							// Non-null by construction: a token only renders under
							// `hasVariables`, which is false without a scope.
							variables={variables!}
						/>
					</span>
				);
			}
			// Render text segments - pointer-events: none so clicks pass through to input
			return (
				<span key={i} className="text-foreground" aria-hidden="true">
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
				id={id}
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
				/*
				 * Combobox, but only where a list can actually appear (issue
				 * #1215). A field with no scope and no plain suggestions never
				 * pops anything up, and calling that a combobox would promise a
				 * list a screen-reader user then cannot find. `aria-controls` and
				 * `aria-activedescendant` name the open list and its highlighted
				 * row, which is the relationship that was missing entirely: the
				 * arrows moved a highlight nothing announced.
				 */
				role={isCombobox ? "combobox" : undefined}
				aria-autocomplete={isCombobox ? "list" : undefined}
				aria-expanded={isCombobox ? listOpen : undefined}
				aria-controls={listOpen ? listboxIds.listboxId : undefined}
				aria-activedescendant={listOpen ? listboxIds.activeOptionId : undefined}
				disabled={disabled}
				className={cn(
					"absolute inset-0 w-full h-full bg-transparent border-0 outline-none px-[inherit] font-[inherit] text-[inherit]",
					"placeholder:text-muted-foreground disabled:cursor-not-allowed",
					// When we have variables, hide real text so the overlay shows through
					hasVariables && "text-transparent caret-foreground selection:bg-primary/30"
				)}
				style={{ zIndex: 1 }}
			/>

			{/*
			 * Visual overlay layer for variable tokens - ON TOP of input for
			 * clickable tokens.
			 *
			 * **Not `aria-hidden`, and the text inside it is** (issues #1215,
			 * #1238). The whole layer used to be hidden from assistive technology,
			 * which is right for what it mostly is - a repaint of text the
			 * `<input>` beneath already carries - and wrong for what it also
			 * holds: tokens the keyboard can land on, and hiding a focusable
			 * control is the `aria-hidden-focus` violation.
			 *
			 * So the duplication is hidden where it actually is - the literal text
			 * either side of a token, which the input does carry - and the tokens
			 * are left in the accessibility tree. Both kinds: #1215 excused the
			 * run-time ones on the grounds that they are not focusable, which they
			 * now are, because their tooltip is the only statement of where the
			 * value comes from and it was mouse-only.
			 */}
			{hasVariables && (
				<div
					ref={overlayRef}
					data-variable-overlay
					className="absolute inset-0 flex items-center px-[inherit] overflow-hidden"
					style={{
						zIndex: 2,
						pointerEvents: "none", // Pass clicks through to input
					}}
					onKeyDown={handleOverlayKeyDown}
					onFocus={handleOverlayFocus}
				>
					<span className="whitespace-pre font-[inherit] text-[inherit]">
						{renderOverlayContent()}
					</span>
				</div>
			)}

			{/* Variable Autocomplete - Use Case 1: Select from list */}
			{variableListOpen && (
				<div className="absolute left-0 top-full mt-1 z-50">
					<VariableAutocomplete
						variables={variablesForAutocomplete}
						searchQuery={searchQuery}
						onSelect={handleSelectVariable}
						dataColumns={variables?.dataColumns}
						value={activeValue}
						onValueChange={setHighlightedValue}
						onListboxState={handleListboxState}
					/>
				</div>
			)}

			{/* Plain Text Suggestions (e.g., for standard headers) */}
			{plainListOpen && (
				<div className="absolute left-0 top-full mt-1 z-50">
					<SuggestionList
						items={filteredSuggestions}
						onSelect={handleSelectSuggestion}
						value={activeValue}
						onValueChange={setHighlightedValue}
						onListboxState={handleListboxState}
					/>
				</div>
			)}
		</div>
	);
}
