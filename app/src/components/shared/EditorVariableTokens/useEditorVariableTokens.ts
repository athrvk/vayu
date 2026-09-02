/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One editor's `{{token}}` affordances: the colour, and the two ways into the
 * popover (issue #1220).
 *
 * Called by `CodeEditor` for every instance, and inert unless all three of these
 * hold - so the settings preview, the response viewers and the script editors
 * keep exactly the behaviour they had:
 *
 *  - a provider is above it, which is what supplies the resolver and the writer;
 *  - the editor is editable, because a response body's `{{x}}` is data someone
 *    was sent, not a variable this app resolves;
 *  - the language is one of `BODY_LANGUAGES`, the same list `{{` completion is
 *    registered for. A script is deliberately not on it: the engine never
 *    interpolates script source, so braces there are literal text (D16 in
 *    `docs/app/variable-resolution.md`), and colouring them would teach a syntax
 *    that does not work.
 *
 * **It returns a mount callback and holds no state.** The editor arrives through
 * `onMount`, and storing it in `useState` would make a caller that re-invokes
 * `onMount` on a render - a test double does, and nothing in the contract
 * forbids it - store a new object, re-render, and be invoked again: an update
 * loop with no exit. Refs and one effect have neither that hazard nor the extra
 * render, at the cost of installing imperatively, which is what Monaco's API is
 * anyway.
 *
 * The hover half is registered globally, per language, by
 * `useVariableHoverProvider` - Monaco takes one hover provider per language, not
 * one per editor.
 */

import { useCallback, useEffect, useRef } from "react";
import type * as Monaco from "monaco-editor";
import type { MonacoApi } from "@/lib/monaco-api";
import { BODY_LANGUAGES } from "@/hooks/useVariableCompletionProvider";
import {
	variableTokenRanges,
	variableTokenClass,
	type VariableTokenRange,
} from "@/lib/monaco-variable-tokens";
import { forgetVariableTokenModel, markVariableTokenModel } from "@/lib/variable-token-models";
import { chordKeybinding } from "@/lib/editor-chords";
import { EDIT_VARIABLE_CHORD } from "@/constants/shortcuts";
import {
	useEditorVariableTokensContext,
	type EditorVariableTokensValue,
	type TokenAnchorRect,
} from "./context";

/**
 * How long after the last keystroke the decorations are recomputed.
 *
 * A repaint walks every line of the model, so doing it per character would put
 * a full scan between the key and the glyph. 150ms is below the threshold where
 * a colour arriving late reads as broken, and above the interval of ordinary
 * typing, so a burst costs one scan rather than one per key.
 */
const REPAINT_DELAY_MS = 150;

/** The token containing @p position, or null when the caret is outside one. */
function tokenAtPosition(
	ranges: VariableTokenRange[],
	position: Monaco.IPosition
): VariableTokenRange | null {
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
	range: VariableTokenRange
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

export interface EditorVariableTokensOptions {
	language: string;
	readOnly: boolean;
}

/** What one editor's installation holds, so unmounting can take it all down. */
interface Installation {
	editor: Monaco.editor.IStandaloneCodeEditor;
	decorations: Monaco.editor.IEditorDecorationsCollection;
	listeners: Monaco.IDisposable[];
	timer?: ReturnType<typeof setTimeout>;
	/** The model currently marked for the hover - see `paint`. */
	marked?: Monaco.editor.ITextModel;
}

export function useEditorVariableTokens({
	language,
	readOnly,
}: EditorVariableTokensOptions): (
	editor: Monaco.editor.IStandaloneCodeEditor,
	monaco: MonacoApi
) => void {
	const tokens = useEditorVariableTokensContext();
	const enabled = !!tokens && !readOnly && BODY_LANGUAGES.includes(language);

	/*
	 * What the imperative handlers read. Monaco's callbacks outlive the render
	 * that registered them, so they must not close over a resolver: they take
	 * the current one from here, the way `openAtCursor` does for the chord.
	 */
	const live = useRef<{ tokens: EditorVariableTokensValue | null; enabled: boolean }>({
		tokens,
		enabled,
	});
	const mounted = useRef<{
		editor: Monaco.editor.IStandaloneCodeEditor;
		monaco: MonacoApi;
	} | null>(null);
	const installation = useRef<Installation | null>(null);

	const paint = useCallback(() => {
		const current = installation.current;
		const context = live.current.tokens;
		if (!current || !context) return;
		const model = current.editor.getModel();
		if (!model) {
			current.decorations.clear();
			return;
		}
		/*
		 * Say so for the hover, which is registered per language and would
		 * otherwise answer for a response body's `{{x}}` too. Marked on every
		 * paint rather than once at install: a body-mode switch hands the editor
		 * a new model, and the mark belongs to the model, not the editor.
		 */
		if (model !== current.marked) {
			if (current.marked) forgetVariableTokenModel(current.marked);
			markVariableTokenModel(model);
			current.marked = model;
		}
		current.decorations.set(
			variableTokenRanges(model).map((range) => ({
				range: {
					startLineNumber: range.lineNumber,
					startColumn: range.startColumn,
					endLineNumber: range.lineNumber,
					endColumn: range.endColumn,
				},
				options: { inlineClassName: variableTokenClass(context.classify(range.name)) },
			}))
		);
	}, []);

	/** Open the popover over a token, if there is anything behind it to edit. */
	const open = useCallback(
		(editor: Monaco.editor.IStandaloneCodeEditor, range: VariableTokenRange) => {
			const context = live.current.tokens;
			if (!context) return;
			// A generator or a bound column has no stored variable to edit, so there
			// is nothing to open - the hover already said what it is.
			if (context.classify(range.name).state === "runtime") return;
			const rect = tokenRect(editor, range);
			if (!rect) return;
			context.openTokenEditor({
				name: range.name,
				rect,
				// Closing puts the caret back where it was: an editor that hands focus
				// away and does not take it back is the defect this program exists to
				// remove (#1218).
				onClose: () => editor.focus(),
			});
		},
		[]
	);

	/** Find the token at a position and open it. */
	const openAt = useCallback(
		(editor: Monaco.editor.IStandaloneCodeEditor, position: Monaco.IPosition | null) => {
			const model = editor.getModel();
			if (!model || !position) return;
			const range = tokenAtPosition(variableTokenRanges(model), position);
			if (range) open(editor, range);
		},
		[open]
	);

	/**
	 * Install the decorations, the ⌘-click and the chord on the mounted editor -
	 * once, and only where the tokens are painted at all.
	 *
	 * Called from the mount callback and again from the effect below, because
	 * either can be the moment all three conditions first hold: an editor that
	 * mounts under a provider installs at mount, and one whose provider arrives
	 * later installs then.
	 */
	const install = useCallback(() => {
		const editor = mounted.current?.editor;
		const monaco = mounted.current?.monaco;
		if (!editor || !monaco || !live.current.enabled || installation.current) return;

		const current: Installation = {
			editor,
			decorations: editor.createDecorationsCollection(),
			listeners: [],
		};
		installation.current = current;

		current.listeners.push(
			editor.onDidChangeModelContent(() => {
				clearTimeout(current.timer);
				current.timer = setTimeout(paint, REPAINT_DELAY_MS);
			}),
			// A body mode switch swaps the model under the same editor, and the
			// new one arrives unpainted.
			editor.onDidChangeModel(() => paint()),
			editor.onMouseDown((event) => {
				// ⌘/Ctrl-click edits, plain click keeps placing the caret - taking
				// the plain one would steal the click that puts the cursor in the
				// middle of a body.
				if (!event.event.ctrlKey && !event.event.metaKey) return;
				if (!event.target.position) return;
				const model = editor.getModel();
				if (!model) return;
				const range = tokenAtPosition(variableTokenRanges(model), event.target.position);
				if (!range) return;
				event.event.preventDefault();
				open(editor, range);
			})
		);

		// `addCommand` has no matching remove, which is the other reason this
		// runs once: a second call would leave the chord bound twice.
		const binding = chordKeybinding(EDIT_VARIABLE_CHORD, monaco);
		if (binding !== null) {
			editor.addCommand(binding, () => openAt(editor, editor.getPosition()));
		}

		paint();
	}, [open, openAt, paint]);

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
		live.current = { tokens, enabled };
		installLatest.current = install;
		install();
		paint();
	}, [tokens, enabled, install, paint]);

	useEffect(() => {
		return () => {
			const current = installation.current;
			if (!current) return;
			clearTimeout(current.timer);
			current.listeners.forEach((listener) => listener.dispose());
			current.decorations.clear();
			// The hover must stop answering for a model this editor no longer
			// paints, even in the window before Monaco disposes it.
			if (current.marked) forgetVariableTokenModel(current.marked);
			installation.current = null;
		};
	}, []);

	return onEditorMount;
}
