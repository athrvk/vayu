/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one wrapper around Monaco: shared configuration (default options, theme, font size) lives
 * here, and consumers pass what varies. **It also loads Monaco**: `ensureMonaco()` pulls the editor
 * and language services in on first mount, not at startup (#1146), and nothing renders `<Editor>`
 * until it resolves, as mounting earlier calls `loader.init()` before `loader.config({ monaco })`
 * and sends @monaco-editor/react to the jsdelivr CDN for a copy the app ships. A skeleton stands in
 * meanwhile; a failed load says so.
 */

import { useState, useEffect, useCallback } from "react";
import { Editor, type EditorProps, type OnMount } from "@monaco-editor/react";
import { useClientSettingsStore } from "@/stores";
import { selectMonoStack } from "@/stores/client-settings-store";
import { registerEditorChords } from "@/lib/editor-chords";
import { ensureMonaco, useLoadedMonaco } from "@/lib/monaco-loader";
import { useMonacoTheme } from "@/hooks/useMonacoTheme";
// The hook's module, not the barrel: the barrel exports the provider, which reaches into the
// request builder, and a `components/ui` primitive must not drag a module tree in.
import { useEditorVariableTokens } from "@/components/shared/EditorVariableTokens/useEditorVariableTokens";
import { TimeTokenCard } from "@/components/shared/EditorVariableTokens/TimeTokenCard";
import { ErrorState } from "@/components/shared/ErrorState";
import { LEAVE_EDITOR_CHORD } from "@/constants/shortcuts";
import { chordKeys } from "@/lib/platform";
import { contextProps } from "@/lib/context-menu";
import { Kbd } from "./kbd";
import { Skeleton } from "./skeleton";
import { cn } from "@/lib/utils";

type EditorOptions = NonNullable<EditorProps["options"]>;

/**
 * The app's scrollbar thickness in px, as `::-webkit-scrollbar` in `index.css` declares it. Monaco
 * draws its scrollbars as DOM no stylesheet reaches, so this is the only way to size them, and an
 * editor sits beside plain scroll panes in the body and script panels, so the two are read
 * together. `scroll-area.test.ts` reads the CSS number back and asserts it matches.
 */
const SCROLLBAR_SIZE = 6;

/** Options shared by every editor instance. */
const DEFAULT_OPTIONS = {
	minimap: { enabled: false },
	lineNumbers: "on",
	scrollBeyondLastLine: false,
	wordWrap: "on",
	tabSize: 2,
	// Honour the configured tab width rather than inferring it from content (Monaco's default would
	// override the preference).
	detectIndentation: false,
	automaticLayout: true,
	scrollbar: {
		/*
		 * Monaco defaults this on, calling preventDefault() on every wheel event over the editor,
		 * even with nothing to scroll, so an editor in a scrollable panel blocks scrolling the
		 * panel past it. It reads as "scrolling stops after resizing": enlarging the editor creates
		 * the overflow and covers where the cursor would scroll. false consumes the wheel only when
		 * the editor can act on it.
		 */
		alwaysConsumeMouseWheel: false,

		verticalScrollbarSize: SCROLLBAR_SIZE,
		horizontalScrollbarSize: SCROLLBAR_SIZE,
	},
	// Suggestion, hover and context-menu widgets in a body-level overlay, so `overflow: hidden`
	// fixed-height containers cannot clip them.
	fixedOverflowWidgets: true,
	autoIndent: "full",
	autoClosingBrackets: "always",
	autoClosingQuotes: "always",
	cursorSmoothCaretAnimation: "on",
} satisfies EditorOptions;

/**
 * The way out of the Tab trap, beside the editor that has one. Only while the editor has focus, so
 * the chord is told when needed and a dozen editors carry no standing badge; read-only editors
 * never show it, as `tabFocusMode` lets Tab leave them. Caps come from `chordKeys` and `Kbd`, like
 * every chord on screen, not a second spelling of `lib/platform.ts`'s modifiers. Not `UrlBar`'s
 * `Hint` (a Radix `Tooltip` on a `TooltipTrigger asChild`): Monaco's `<Editor>` forwards no ref a
 * trigger can attach to, so this takes the popover shape (`bg-popover`, a border, a shadow). The
 * border is not `border-rule`: this is the one surface floating over Monaco's canvas rather than a
 * declared app surface, so there is no `--rule` to inherit, and the fill cannot separate it (the
 * canvas is `--background`, which `--popover` sits a step above in dark and is 96% against white in
 * light, #1321). `border-border-strong` reads on both, and `Kbd` is built from it.
 */
function LeaveEditorHint() {
	return (
		<div className="enter-fade pointer-events-none absolute bottom-1.5 right-3 z-10 flex items-center gap-1 rounded-md border border-border-strong bg-popover px-1.5 py-1 text-popover-foreground shadow-md">
			<span className="text-micro leading-none text-muted-foreground">Leave editor</span>
			{chordKeys(LEAVE_EDITOR_CHORD).map((cap) => (
				<Kbd key={cap} size="sm">
					{cap}
				</Kbd>
			))}
		</div>
	);
}

export interface CodeEditorProps {
	value: string;
	language: string;
	/**
	 * What this editor is, for a screen reader ("Request body", "Post-request script"). Required
	 * and per call site, not derived from `language`: two editors share a language and never a job
	 * (GraphQL variables and the body are both `json`), and a dozen "Editor content" announcements
	 * are none. `code-editor.aria-label.test.tsx` holds the labels distinct; the type holds them
	 * present.
	 */
	ariaLabel: string;
	/**
	 * The Monaco model's URI, and with it its undo stack, cursor and scroll. Give one when an
	 * editor serves several documents (the request builder's, across tabs): a changed `value` is
	 * applied as an undoable edit, so without a path per document undo restores another's text. The
	 * library disposes only the model held at unmount, so the caller picking paths ends the rest
	 * (`useRequestModelLifecycle`). Omitted, the editor keeps one anonymous model.
	 */
	path?: string;
	/** Coalesces Monaco's `string | undefined` to a plain string. */
	onChange?: (value: string) => void;
	/** CSS height; use "100%" inside flex containers. */
	height?: string | number;
	readOnly?: boolean;
	fontSize?: number;
	/** Merged over (and able to override) the shared defaults. */
	options?: EditorOptions;
	className?: string;
	onMount?: OnMount;
}

export function CodeEditor({
	value,
	language,
	ariaLabel,
	path,
	onChange,
	height = "100%",
	readOnly = false,
	fontSize,
	options,
	className,
	onMount,
}: CodeEditorProps) {
	const themeName = useMonacoTheme();
	const editor = useClientSettingsStore((s) => s.editor);
	const monoStack = useClientSettingsStore(selectMonoStack);
	const monaco = useLoadedMonaco();
	const [loadFailed, setLoadFailed] = useState(false);
	const [hasFocus, setHasFocus] = useState(false);
	/*
	 * `{{variable}}` colouring, hover and edit chord (#1220), inert unless a provider is above an
	 * editable editor; and the time underline (#1786) wherever the language has a time matcher. The
	 * time card is drawn here, as most read-only editors have no provider to draw it.
	 */
	const { onMount: mountEditorTokens, timeHover } = useEditorVariableTokens({
		language,
		readOnly,
	});

	useEffect(() => {
		let active = true;
		void ensureMonaco().catch((error: unknown) => {
			// Loud, not silent: otherwise the skeleton would sit forever looking like a slow load.
			console.error("Monaco failed to load", error);
			if (active) setLoadFailed(true);
		});
		return () => {
			active = false;
		};
	}, []);

	/*
	 * Every editor gets the window chords Monaco would eat, here, not per call site: making an
	 * editor behave like the app is the wrapper's job, and there are a dozen (#938). The caller's
	 * `onMount` still runs.
	 */
	const handleMount = useCallback<OnMount>(
		(instance, monaco) => {
			registerEditorChords(instance, monaco);
			mountEditorTokens(instance, monaco);
			onMount?.(instance, monaco);
		},
		[onMount, mountEditorTokens]
	);

	// User preferences override the shared defaults; an explicit `fontSize` prop beats the
	// preference, and per-call `options` beat everything.
	const prefOptions: EditorOptions = {
		fontSize: fontSize ?? editor.fontSize,
		fontFamily: monoStack,
		wordWrap: editor.wordWrap ? "on" : "off",
		minimap: { enabled: editor.minimap },
		lineNumbers: editor.lineNumbers ? "on" : "off",
		tabSize: editor.tabSize,
	};

	if (loadFailed) {
		return (
			<div role="alert" style={{ height }} className={className}>
				<ErrorState
					variant="inline"
					title="Couldn't load the editor. Reopen the app to try again."
					className="h-full p-3"
				/>
			</div>
		);
	}

	if (!monaco) {
		return (
			<div
				role="status"
				aria-label="Loading editor"
				style={{ height }}
				className={cn("p-2", className)}
			>
				<Skeleton className="h-full w-full rounded-md" />
			</div>
		);
	}

	return (
		/*
		 * The wrapper positions the hint against the editor's box. `className` and `height` stay on
		 * it, not on `<Editor>`, so call sites lay out as before and the two states above, which
		 * render their own box, keep its shape.
		 */
		<div
			// Monaco has its own context menu, so the app's must not open over it (#1359). Marked,
			// not detected: an editor stopping the event before it bubbles still gets one menu.
			{...contextProps("monaco")}
			className={cn("relative", className)}
			style={{ height }}
			onFocus={() => setHasFocus(true)}
			onBlur={(e) => {
				// Monaco moves focus among its own nodes (the hidden textarea, the find widget);
				// only focus leaving the editor counts.
				if (!e.currentTarget.contains(e.relatedTarget)) setHasFocus(false);
			}}
		>
			<Editor
				height="100%"
				language={language}
				path={path}
				value={value}
				theme={themeName}
				onChange={onChange ? (v) => onChange(v ?? "") : undefined}
				onMount={handleMount}
				options={{
					...DEFAULT_OPTIONS,
					...prefOptions,
					readOnly,
					ariaLabel,
					/*
					 * Tab moves focus in an editor nobody types into: with no indentation to
					 * insert, Monaco's default is a keyboard trap (WCAG 2.1.2). Editable editors
					 * keep Tab and get `LEAVE_EDITOR_CHORD` plus the hint.
					 */
					tabFocusMode: readOnly,
					/*
					 * Monaco stops painting a line after 10,000 columns, which in a viewer hides
					 * part of a minified response (one line); -1 draws it all. An editable model
					 * keeps the default, as painting a very long line while typing is the cost it
					 * caps. `options` can override either.
					 */
					stopRenderingLineAfter: readOnly ? -1 : undefined,
					...options,
					// `scrollbar` is nested, so a caller's key would replace the object and drop
					// the wheel default above; merged a level deeper.
					scrollbar: { ...DEFAULT_OPTIONS.scrollbar, ...options?.scrollbar },
				}}
			/>
			{!readOnly && hasFocus && <LeaveEditorHint />}
			{timeHover && <TimeTokenCard request={timeHover} />}
		</div>
	);
}
