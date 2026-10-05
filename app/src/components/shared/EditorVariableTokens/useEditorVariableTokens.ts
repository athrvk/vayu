/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One editor's token layer: the `{{token}}` colour and the two ways into its
 * popover (issue #1220; script support added later under the same issue), and
 * the underline and card on a time (issue #1786).
 *
 * Called by `CodeEditor` for every instance, and gated per matcher.
 *
 * **Times** are underlined wherever the language has an entry in
 * `TIME_TOKEN_MATCHERS` (`lib/monaco-time-tokens.ts`), read-only or not and
 * with or without a provider: a response body, the console and a stream's
 * events are where a time is read. The card is drawn by `CodeEditor` from the
 * `timeHover` this hook returns, because most of those editors have no
 * provider above them to draw it.
 *
 * **Variables** are painted only where both of these hold - so the settings
 * preview and the response viewers keep exactly the behaviour they had:
 *
 *  - a provider is above it, which is what supplies the resolver and the writer;
 *  - the editor is editable, because a response body's `{{x}}` is data someone
 *    was sent, not a variable this app resolves;
 *
 * and the language has an entry in `VARIABLE_TOKEN_MATCHERS`
 * (`monaco-variable-tokens.ts`) - `json`, `plaintext`, `graphql` and `xml`
 * share the plain `{{name}}` matcher, and `javascript` gets its own
 * (`lib/script-variable-tokens.ts`): a script reaches a variable through
 * `pm.<accessor>.get(...)`, `pm.variables.replaceIn(...)`, or - not
 * interpolated at all, so painted muted and read-only - a bare `{{name}}`
 * (D16, `docs/engine/scripting.md`). This is a different gate from
 * `BODY_LANGUAGES` in `useVariableCompletionProvider.ts`, which is the `{{`
 * **completion** list's own list and stays as it is: offering brace
 * completion in a script would still teach the wrong syntax, even though the
 * script's *existing* tokens are now worth painting.
 *
 * **It returns a mount callback, and keeps the editor out of state.** The
 * editor arrives through `onMount`, and storing it in `useState` would make a
 * caller that re-invokes `onMount` on a render - a test double does, and
 * nothing in the contract forbids it - store a new object, re-render, and be
 * invoked again: an update loop with no exit. Refs and one effect have neither
 * that hazard nor the extra render, at the cost of installing imperatively,
 * which is what Monaco's API is anyway. The one piece of state is the time
 * card, set from a hover timer and never from `onMount`.
 *
 * **The hover is this editor's too** (issue #1320). It used to be a Monaco
 * hover provider, registered once per language for the whole app, which is why
 * the token had to mark its model for the provider to know which `{{x}}` was a
 * variable and which was a response body someone was sent. The card is now the
 * app's own tooltip over the token's rectangle, drawn by the provider that
 * already draws the popover there - so it exists only on editors that reach
 * this far, and the marking, the model registry and the per-language
 * registration are all gone with it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import type { MonacoApi } from "@/lib/monaco-api";
import {
	VARIABLE_TOKEN_MATCHERS,
	variableTokenClass,
	type VariableTokenMatcher,
	type VariableTokenRange,
} from "@/lib/monaco-variable-tokens";
import {
	TIME_TOKEN_CLASS,
	TIME_TOKEN_MATCHERS,
	type TimeTokenMatcher,
	type TimeTokenRange,
} from "@/lib/monaco-time-tokens";
import { describeInstant } from "@/lib/time-value";
import { chordKeybinding } from "@/lib/editor-chords";
import { TIMING } from "@/config/timing";
import { EDIT_VARIABLE_CHORD } from "@/constants/shortcuts";
import {
	useEditorVariableTokensContext,
	type EditorVariableTokensValue,
	type TokenAnchorRect,
} from "./context";
import type { TimeHoverRequest } from "./TimeTokenCard";

/**
 * How long after the last keystroke the decorations are recomputed.
 *
 * A repaint walks every line of the model, so doing it per character would put
 * a full scan between the key and the glyph. 150ms is below the threshold where
 * a colour arriving late reads as broken, and above the interval of ordinary
 * typing, so a burst costs one scan rather than one per key.
 */
const REPAINT_DELAY_MS = 150;

/** A span of one line, which both kinds of range are. */
interface LineSpan {
	lineNumber: number;
	startColumn: number;
	endColumn: number;
}

/** The token containing @p position, or null when the caret is outside one. */
function tokenAtPosition<Range extends LineSpan>(
	ranges: Range[],
	position: Monaco.IPosition
): Range | null {
	return (
		ranges.find(
			(range) =>
				range.lineNumber === position.lineNumber &&
				position.column >= range.startColumn &&
				position.column <= range.endColumn
		) ?? null
	);
}

/**
 * Where a token sits on screen, or null when it is scrolled out of view.
 *
 * `getScrolledVisiblePosition` answers in the editor's own coordinates, so the
 * editor's box turns it into the viewport ones a fixed-position anchor needs.
 */
function tokenRect(
	editor: Monaco.editor.IStandaloneCodeEditor,
	range: LineSpan
): TokenAnchorRect | null {
	const dom = editor.getDomNode();
	const start = editor.getScrolledVisiblePosition({
		lineNumber: range.lineNumber,
		column: range.startColumn,
	});
	if (!dom || !start) return null;
	const end = editor.getScrolledVisiblePosition({
		lineNumber: range.lineNumber,
		column: range.endColumn,
	});
	const box = dom.getBoundingClientRect();
	return {
		left: box.left + start.left,
		top: box.top + start.top,
		width: end ? Math.max(end.left - start.left, 1) : 1,
		height: start.height,
	};
}

/** A decoration painting @p span with one `index.css` class. */
function spanDecoration(span: LineSpan, className: string): Monaco.editor.IModelDeltaDecoration {
	return {
		range: {
			startLineNumber: span.lineNumber,
			startColumn: span.startColumn,
			endLineNumber: span.lineNumber,
			endColumn: span.endColumn,
		},
		options: { inlineClassName: className },
	};
}

/** Each variable in the colour its state earns - none without a provider. */
function variableDecorations(
	ranges: VariableTokenRange[],
	tokens: EditorVariableTokensValue | null
): Monaco.editor.IModelDeltaDecoration[] {
	if (!tokens) return [];
	return ranges.map((range) =>
		spanDecoration(range, variableTokenClass(tokens.classify(range.name, range.scriptHint)))
	);
}

export interface EditorVariableTokensOptions {
	language: string;
	readOnly: boolean;
}

/** What `CodeEditor` takes from the hook. */
export interface EditorTokenLayer {
	/** Hand Monaco's `onMount` arguments here; one stable identity. */
	onMount: (editor: Monaco.editor.IStandaloneCodeEditor, monaco: MonacoApi) => void;
	/** The time card to draw as `TimeTokenCard`, or null when none is showing. */
	timeHover: TimeHoverRequest | null;
}

/** What the imperative handlers read - see `live` in the hook. */
interface LiveMatchers {
	tokens: EditorVariableTokensValue | null;
	/** Undefined wherever variables are not painted: no provider, read-only, or no matcher. */
	variableMatcher: VariableTokenMatcher | undefined;
	timeMatcher: TimeTokenMatcher | undefined;
}

/** Where `VariablePopover` renders its content - see `variable-popover.tsx`. */
const POPOVER_CONTENT_SELECTOR = '[data-slot="popover-content"]';

/** What one editor's installation holds, so unmounting can take it all down. */
interface Installation {
	editor: Monaco.editor.IStandaloneCodeEditor;
	decorations: Monaco.editor.IEditorDecorationsCollection;
	listeners: Monaco.IDisposable[];
	timer?: ReturnType<typeof setTimeout>;
	/** Counting down to the tooltip or popover the pointer has been resting on. */
	hoverTimer?: ReturnType<typeof setTimeout>;
	/** The token that tooltip or popover is for, showing or pending - see `hoverAt`. */
	hovered?: string;
	/**
	 * The token key this editor's own hover currently has the shared popover
	 * open over, if any (issue #1220 hover redesign). Set only for an editable
	 * token - a run-time one still gets `TokenHoverCard` - and read by the leave
	 * handlers to know whether there is a hover-opened popover of this editor's
	 * to close, as opposed to a tooltip.
	 */
	hoverOpenKey?: string;
	/** Counting down the leave-grace before a hover-opened popover closes. */
	hoverCloseTimer?: ReturnType<typeof setTimeout>;
	/**
	 * Whether the pointer is confirmed to be over the hover-opened popover's own
	 * content right now (issue #1220 leave-grace hardening).
	 *
	 * Monaco's own `onMouseLeave` fires twice for one physical pointer crossing
	 * from the editor onto the popover - `PointerEventHandler` and `MouseHandler`
	 * (monaco-editor's `controller/pointerHandler.js` and `mouseHandler.js`) each
	 * attach their own leave listener to the same DOM node, for `pointerleave`
	 * and native `mouseleave` respectively. The order observed is: Monaco's
	 * first leave arms the close timer, the content's own `onContentMouseEnter`
	 * cancels it, then Monaco's *second* leave re-arms it - with the pointer now
	 * resting motionless on the content and nothing left to cancel that second
	 * timer, so it fires and closes a popover the pointer never actually left.
	 * Gating `scheduleHoverClose` on this flag, rather than trusting that a
	 * cancel always arrives after every arm, makes the fix immune to how many
	 * times either side's leave fires.
	 */
	pointerOnContent?: boolean;
	/**
	 * The spans `paint` last found, read back by `hoverAt` instead of scanning
	 * again. A per-character mouse move used to re-scan the one line under the
	 * pointer; a script's spans are not line-local (a `replaceIn(...)` argument
	 * or a block comment can open on an earlier line), so the fix that covers
	 * every language is to answer from what the last paint already found rather
	 * than re-deriving a line-local answer per language.
	 */
	ranges: VariableTokenRange[];
	/** The times `paint` last found, cached for `hoverAt` the same way. */
	timeRanges: TimeTokenRange[];
	/**
	 * Whether the edit chord is bound. Separate from the installation because
	 * an editor installed for its times alone gains variables when it turns
	 * editable, and `addCommand` has no remove to undo a second binding.
	 */
	chordBound?: boolean;
}

/** Identifies a token across mouse moves: the same name, in the same place. */
function tokenKey(range: VariableTokenRange): string {
	return `${range.lineNumber}:${range.startColumn}:${range.name}`;
}

/** What the pointer can rest on: a variable opens its card or popover, a time its card. */
type HoverTarget =
	{ kind: "variable"; range: VariableTokenRange } | { kind: "time"; range: TimeTokenRange };

/**
 * What is under @p position, from the last paint. A variable first: a script's
 * `pm.environment.get("2026-10-05")` argument is both, and what it reads is
 * the variable.
 */
function targetAt(current: Installation, position: Monaco.IPosition): HoverTarget | null {
	const variable = tokenAtPosition(current.ranges, position);
	if (variable) return { kind: "variable", range: variable };
	const time = tokenAtPosition(current.timeRanges, position);
	return time ? { kind: "time", range: time } : null;
}

/** Identifies a target across mouse moves: the same kind, in the same place. */
function targetKey(target: HoverTarget): string {
	return target.kind === "variable"
		? tokenKey(target.range)
		: `time:${target.range.lineNumber}:${target.range.startColumn}`;
}

export function useEditorVariableTokens({
	language,
	readOnly,
}: EditorVariableTokensOptions): EditorTokenLayer {
	const context = useEditorVariableTokensContext();
	// Gated per matcher (#1786): a `{{x}}` needs a provider to resolve it and
	// an editable editor to be anything but data; a time needs neither.
	const variableMatcher = context && !readOnly ? VARIABLE_TOKEN_MATCHERS[language] : undefined;
	const timeMatcher = TIME_TOKEN_MATCHERS[language];
	// The provider only where variables are painted: a read-only viewer under
	// one must not rescan its body every time a variable changes.
	const tokens = variableMatcher ? context : null;
	const [timeHover, setTimeHover] = useState<TimeHoverRequest | null>(null);

	/*
	 * What the imperative handlers read. Monaco's callbacks outlive the render
	 * that registered them, so they must not close over a resolver: they take
	 * the current one from here, the way `openAtCursor` does for the chord.
	 */
	const live = useRef<LiveMatchers>({ tokens, variableMatcher, timeMatcher });
	const mounted = useRef<{
		editor: Monaco.editor.IStandaloneCodeEditor;
		monaco: MonacoApi;
	} | null>(null);
	const installation = useRef<Installation | null>(null);

	const paint = useCallback(() => {
		const current = installation.current;
		if (!current) return;
		const model = current.editor.getModel();
		const { tokens, variableMatcher, timeMatcher } = live.current;
		// Cached for `hoverAt`, which answers from the last paint rather than
		// scanning again on every pointer move - see the field's own comment.
		current.ranges = model && variableMatcher ? variableMatcher(model) : [];
		current.timeRanges = model && timeMatcher ? timeMatcher(model) : [];
		current.decorations.set([
			...variableDecorations(current.ranges, tokens),
			...current.timeRanges.map((range) => spanDecoration(range, TIME_TOKEN_CLASS)),
		]);
	}, []);

	/** Close the popover this editor's hover opened, if one is open. */
	const closeHoverPopover = useCallback((current: Installation) => {
		if (current.hoverOpenKey === undefined) return;
		const token = current.hoverOpenKey;
		current.hoverOpenKey = undefined;
		live.current.tokens?.closeTokenEditor(token);
	}, []);

	/** Take the tooltip down, and forget whatever it was counting down to. */
	const hideHover = useCallback(() => {
		const current = installation.current;
		if (!current) return;
		clearTimeout(current.hoverTimer);
		current.hoverTimer = undefined;
		clearTimeout(current.hoverCloseTimer);
		current.hoverCloseTimer = undefined;
		current.pointerOnContent = false;
		closeHoverPopover(current);
		if (current.hovered === undefined) return;
		current.hovered = undefined;
		live.current.tokens?.setHoveredToken(null);
		setTimeHover(null);
	}, [closeHoverPopover]);

	/**
	 * The pointer left the token that opened a hover popover - not the editor
	 * necessarily, just the token - so the popover has to be told, but not
	 * instantly: the reader may be moving the pointer *into* it, to click the
	 * value field or read a shadowed definition (issue #1220 hover redesign).
	 *
	 * Immediate where there is nothing to wait for - a scroll or a model change
	 * invalidates the anchor rectangle outright, so `hideHover` there stays
	 * unconditional; this is only for the ordinary "pointer moved off" case.
	 */
	const scheduleHoverClose = useCallback(() => {
		const current = installation.current;
		if (!current || current.hoverOpenKey === undefined) return;
		// The pointer is confirmed on the content right now - see `pointerOnContent`'s
		// own comment for why this cannot instead trust that every arm is paired
		// with a later cancel.
		if (current.pointerOnContent) return;
		clearTimeout(current.hoverCloseTimer);
		current.hoverCloseTimer = setTimeout(() => {
			const content = document.querySelector<HTMLElement>(POPOVER_CONTENT_SELECTOR);
			if (content && content.contains(document.activeElement)) return;
			const stillCurrent = installation.current;
			if (!stillCurrent || stillCurrent.hoverOpenKey === undefined) return;
			const token = stillCurrent.hoverOpenKey;
			stillCurrent.hoverOpenKey = undefined;
			stillCurrent.hovered = undefined;
			live.current.tokens?.closeTokenEditor(token);
		}, TIMING.VARIABLE_POPOVER_LEAVE_GRACE_MS);
	}, []);

	/**
	 * Show a variable's answer: `TokenHoverCard` for a run-time token, which has
	 * no popover to open at all, and the shared popover, inert, for the rest.
	 */
	const showVariableHover = useCallback(
		(
			editor: Monaco.editor.IStandaloneCodeEditor,
			current: Installation,
			range: VariableTokenRange,
			key: string,
			rect: TokenAnchorRect
		) => {
			const context = live.current.tokens;
			if (!context) return;
			setTimeHover(null);
			const kind = context.classify(range.name, range.scriptHint);
			if (kind.state === "runtime") {
				context.setHoveredToken({
					name: range.name,
					rect,
					scriptHint: range.scriptHint,
				});
				return;
			}
			current.hoverOpenKey = key;
			// A fresh open, however the previous one ended - never inherit a stale
			// flag from a token whose content the pointer never actually left
			// before this one took over.
			current.pointerOnContent = false;
			context.openTokenEditor({
				name: range.name,
				rect,
				scriptHint: range.scriptHint,
				// So a leave-grace close armed for this token can tell, once it
				// fires, whether it is still the popover open - see
				// `TokenEditRequest.hoverToken`.
				hoverToken: key,
				// Inert: resting the pointer must never steal focus or the caret
				// from wherever the reader is actually typing.
				focus: false,
				// See `EditorVariableTokensProvider`'s `close`: this only actually
				// runs if the popover took focus at some point, so an untouched
				// hover closing never yanks focus off another field.
				onClose: () => editor.focus(),
				// Cancel the leave-grace once the pointer is confirmed on the
				// content, and restart it once the pointer leaves the content
				// again - ordinary props on `VariablePopover`'s own content, wired
				// through the provider, rather than this hook reaching for the
				// node itself once it exists. `pointerOnContent` is set here and
				// read inside `scheduleHoverClose` itself (see that flag's own
				// comment) rather than trusted to a plain `clearTimeout`, because
				// Monaco's own leave can fire again afterward and re-arm the timer
				// with the pointer still on the content.
				onContentMouseEnter: () => {
					current.pointerOnContent = true;
					clearTimeout(current.hoverCloseTimer);
				},
				onContentMouseLeave: () => {
					current.pointerOnContent = false;
					scheduleHoverClose();
				},
			});
		},
		[scheduleHoverClose]
	);

	/**
	 * Show a time's card - read-only, so never the popover, and never anything
	 * a variable hover left open.
	 */
	const showTimeHover = useCallback(
		(current: Installation, range: TimeTokenRange, rect: TokenAnchorRect) => {
			closeHoverPopover(current);
			live.current.tokens?.setHoveredToken(null);
			const { instant, hasZone } = range.parsed;
			setTimeHover({
				rect,
				text: range.text,
				// Built when the card opens, so "Relative" is relative to now.
				rows: describeInstant(instant, {}, { text: range.text, hasZone }),
			});
		},
		[closeHoverPopover]
	);

	/**
	 * The pointer moved: show what is under it, hide anything else.
	 *
	 * The delay is the app's own tooltip delay rather than Monaco's, because
	 * what opens is the app's own popover - the same one, after the same wait,
	 * that opens over a `{{token}}` in the URL bar one row above (issue #1220
	 * hover redesign). Moving along a line of text fires this per character, so
	 * a move that stays inside the token already showing does nothing at all:
	 * re-arming the timer there would mean a hover that never opens while the
	 * hand is not perfectly still.
	 */
	const hoverAt = useCallback(
		(editor: Monaco.editor.IStandaloneCodeEditor, position: Monaco.IPosition | null) => {
			const current = installation.current;
			const { variableMatcher, timeMatcher } = live.current;
			if (!current || (!variableMatcher && !timeMatcher)) {
				// Nothing painted any more - a body mode that left the token
				// languages, say. Whatever is on screen is about a span gone.
				hideHover();
				return;
			}
			// From the last paint, not a fresh scan: this fires per character of
			// pointer travel, and a script's spans are not one line's business
			// alone (a `replaceIn(...)` argument or a bare template can start on an
			// earlier line than the one under the pointer).
			const target = position ? targetAt(current, position) : null;
			if (!target) {
				// A hover-opened popover gets the grace period; a plain tooltip has
				// no interactive content to move into and comes down at once, exactly
				// as it always has.
				if (current.hoverOpenKey !== undefined) scheduleHoverClose();
				else hideHover();
				return;
			}
			// Landed back on the token a hover-opened popover is already showing -
			// nothing pending to cancel or start over.
			clearTimeout(current.hoverCloseTimer);
			const key = targetKey(target);
			if (current.hovered === key) return;
			clearTimeout(current.hoverTimer);
			current.hovered = key;
			current.hoverTimer = setTimeout(() => {
				// Measured when it opens, not when the pointer arrived: a scroll or
				// an edit in between moved the token, and the card points at where
				// it is now or does not open at all.
				const rect = tokenRect(editor, target.range);
				if (!rect) return;
				if (target.kind === "time") showTimeHover(current, target.range, rect);
				else showVariableHover(editor, current, target.range, key, rect);
			}, TIMING.TOOLTIP_DELAY_MS);
		},
		[hideHover, scheduleHoverClose, showTimeHover, showVariableHover]
	);

	/** Open the popover over a token, if there is anything behind it to edit. */
	const open = useCallback(
		(editor: Monaco.editor.IStandaloneCodeEditor, range: VariableTokenRange) => {
			const context = live.current.tokens;
			if (!context) return;
			// Whatever happens next, the pointer's tooltip or hover-opened popover
			// is not part of it: this open carries the same value over the same
			// rectangle, freshly.
			hideHover();
			// A generator, a bound column, or a script's bare `{{name}}` (never
			// interpolated, so never editable) all classify as "runtime" - nothing
			// stored behind any of them to open. The hover already said what it is.
			if (context.classify(range.name, range.scriptHint).state === "runtime") return;
			const rect = tokenRect(editor, range);
			if (!rect) return;
			context.openTokenEditor({
				name: range.name,
				rect,
				scriptHint: range.scriptHint,
				// A keyboard user has no hover state, so this open has to land focus
				// inside the popover to be reachable at all.
				focus: true,
				// Closing puts the caret back where it was: an editor that hands focus
				// away and does not take it back is the defect this program exists to
				// remove (#1218).
				onClose: () => editor.focus(),
			});
		},
		[hideHover]
	);

	/** Find the token at a position and open it - a fresh scan, not the paint's cache. */
	const openAt = useCallback(
		(editor: Monaco.editor.IStandaloneCodeEditor, position: Monaco.IPosition | null) => {
			const model = editor.getModel();
			const matcher = live.current.variableMatcher;
			if (!model || !position || !matcher) return;
			const range = tokenAtPosition(matcher(model), position);
			if (range) open(editor, range);
		},
		[open]
	);

	/**
	 * Listen to the editor - once, for its life: the text, the model, the
	 * pointer and the scroll. What each handler does reads `live`, so the same
	 * listeners serve a time-only editor and one that later paints variables.
	 */
	const listen = useCallback(
		(editor: Monaco.editor.IStandaloneCodeEditor): Installation => {
			const current: Installation = {
				editor,
				decorations: editor.createDecorationsCollection(),
				listeners: [],
				ranges: [],
				timeRanges: [],
			};
			current.listeners.push(
				editor.onDidChangeModelContent(() => {
					clearTimeout(current.timer);
					current.timer = setTimeout(paint, REPAINT_DELAY_MS);
					// The text under the pointer just moved, so the card is pointing at
					// a token that is no longer there.
					hideHover();
				}),
				// A body mode switch swaps the model under the same editor, and the
				// new one arrives unpainted.
				editor.onDidChangeModel(() => {
					hideHover();
					paint();
				}),
				editor.onMouseMove((event) => hoverAt(editor, event.target?.position ?? null)),
				/*
				 * Off the editor entirely. A hover-opened popover gets the grace period
				 * rather than an immediate close - it lives outside the editor's own
				 * DOM, so leaving the editor is exactly what happens on the way into it
				 * (issue #1220 hover redesign). Whatever tooltip is pending or showing
				 * closes at once either way: there is nothing pointer-driven left to
				 * wait for once the pointer has left.
				 */
				editor.onMouseLeave(() => {
					clearTimeout(current.hoverTimer);
					current.hoverTimer = undefined;
					if (current.hoverOpenKey !== undefined) {
						scheduleHoverClose();
						return;
					}
					hideHover();
				}),
				// On a scroll: the rectangle the card or popover was drawn over belongs
				// to a line that has moved, so this stays immediate rather than taking
				// the leave-grace - unlike a leave onto the popover's own content, a
				// scroll is never "the reader moving toward it".
				editor.onDidScrollChange(() => hideHover())
			);
			// A plain click on a token now does nothing beyond letting Monaco's own
			// native caret placement proceed - hover and the edit chord are the
			// popover's only ways in (issue #1220 hover redesign), so there is no
			// `onMouseDown` handler here any more to open one.
			return current;
		},
		[hideHover, hoverAt, paint, scheduleHoverClose]
	);

	/**
	 * Install the listeners, and the edit chord where variables are painted, on
	 * the mounted editor - each once, and only where some matcher applies.
	 *
	 * Called from the mount callback and again from the effect below, because
	 * either can be the moment the conditions first hold: an editor that mounts
	 * under a provider installs at mount, and one whose provider arrives later
	 * installs then.
	 */
	const install = useCallback(() => {
		const editor = mounted.current?.editor;
		const monaco = mounted.current?.monaco;
		const { variableMatcher, timeMatcher } = live.current;
		if (!editor || !monaco || (!variableMatcher && !timeMatcher)) return;
		if (!installation.current) {
			installation.current = listen(editor);
			paint();
		}
		const current = installation.current;
		// The chord opens a variable, so it waits for variables to be painted. A
		// read-only viewer never carries it; `openAt` reads the live matcher, so
		// one bound earlier opens nothing once variables stop being painted.
		if (!variableMatcher || current.chordBound) return;
		current.chordBound = true;
		const binding = chordKeybinding(EDIT_VARIABLE_CHORD, monaco);
		if (binding !== null) {
			editor.addCommand(binding, () => openAt(editor, editor.getPosition()));
		}
	}, [listen, openAt, paint]);

	/*
	 * The install, reachable from the mount callback without that callback
	 * closing over a render. Assigned in the effect below rather than here: a
	 * ref read during render is both a lint error and a real hazard.
	 */
	const installLatest = useRef<() => void>(() => {});

	/*
	 * One stable identity, so `CodeEditor`'s own `onMount` stays memoised.
	 *
	 * It installs as well as recording, because *when* Monaco calls `onMount` is
	 * not fixed: the editor is created in `@monaco-editor/react`'s own effect,
	 * which is the commit's child effect and lands before the effect below - but
	 * a load that resolves a tick later calls it after, with no render to
	 * follow. Installing from both places, guarded by "once", covers either
	 * order; a single call site would leave one of them painting nothing.
	 */
	const onEditorMount = useCallback(
		(editor: Monaco.editor.IStandaloneCodeEditor, monaco: MonacoApi) => {
			mounted.current = { editor, monaco };
			installLatest.current();
		},
		[]
	);

	/*
	 * Deliberately not on every render: `paint` walks the model, and this
	 * component re-renders on every keystroke in the body it is showing. The
	 * text is the debounced listener's business; this effect is the *variables*
	 * changing, or the provider arriving.
	 */
	useEffect(() => {
		// A card showing over a span this editor has stopped painting goes now,
		// rather than at whatever pointer event happens to come next - and before
		// `live` moves on, since it closes through the provider that opened it.
		if (!variableMatcher || !timeMatcher) hideHover();
		live.current = { tokens, variableMatcher, timeMatcher };
		installLatest.current = install;
		install();
		paint();
	}, [tokens, variableMatcher, timeMatcher, hideHover, install, paint]);

	useEffect(() => {
		return () => {
			const current = installation.current;
			if (!current) return;
			clearTimeout(current.timer);
			// The tooltip is the provider's, and it outlives this editor: an editor
			// unmounted with the pointer on a token would otherwise leave its card
			// hanging over whatever replaced it.
			hideHover();
			current.listeners.forEach((listener) => listener.dispose());
			current.decorations.clear();
			installation.current = null;
		};
	}, [hideHover]);

	return { onMount: onEditorMount, timeHover };
}
