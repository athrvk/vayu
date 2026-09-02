/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * CodeEditor
 *
 * Single wrapper around the Monaco editor. All shared editor configuration
 * (default options, theme, font size) lives here so it only has to change in
 * one place. Consumers pass only what varies (language, value, height, etc.).
 *
 * **This is also where Monaco is loaded.** `ensureMonaco()` pulls the editor
 * and its language services in on the first mount rather than at startup
 * (#1146), and nothing renders `<Editor>` until that resolves - mounting it
 * earlier would call `loader.init()` before `loader.config({ monaco })` and
 * send @monaco-editor/react to the jsdelivr CDN for a copy the app already
 * ships. A skeleton stands in meanwhile; a failed load says so rather than
 * leaving a placeholder that never resolves.
 */

import { useState, useEffect, useCallback } from "react";
import { Editor, type EditorProps, type OnMount } from "@monaco-editor/react";
import { useClientSettingsStore } from "@/stores";
import { selectMonoStack } from "@/stores/client-settings-store";
import { registerEditorChords } from "@/lib/editor-chords";
import { ensureMonaco, useLoadedMonaco } from "@/lib/monaco-loader";
import { LEAVE_EDITOR_CHORD } from "@/constants/shortcuts";
import { chordKeys } from "@/lib/platform";
import { Kbd } from "./kbd";
import { Skeleton } from "./skeleton";
import { cn } from "@/lib/utils";

type EditorOptions = NonNullable<EditorProps["options"]>;

function useDarkMode() {
	const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"));
	useEffect(() => {
		const observer = new MutationObserver(() => {
			setIsDark(document.documentElement.classList.contains("dark"));
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class"],
		});
		return () => observer.disconnect();
	}, []);
	return isDark;
}

/**
 * The app's scrollbar thickness, in px, as declared by `::-webkit-scrollbar` in
 * `index.css`.
 *
 * Monaco renders its own scrollbars as DOM inside the editor, so no stylesheet
 * rule reaches them and this is the only way to size them. It shipped at
 * Monaco's defaults - 14px vertical, 12px horizontal - which passed unnoticed
 * beside a 10px native bar and would be 2.3x one at 6px. An editor sits
 * directly beside plain scroll panes in the body and script panels, so the two
 * are read together.
 *
 * `scroll-area.test.ts` reads the number back out of the CSS and asserts it
 * matches this one, which is what keeps a third system from drifting again.
 */
const SCROLLBAR_SIZE = 6;

/** Options shared by every editor instance. */
const DEFAULT_OPTIONS = {
	minimap: { enabled: false },
	lineNumbers: "on",
	scrollBeyondLastLine: false,
	wordWrap: "on",
	tabSize: 2,
	// Honor the user's configured tab width instead of inferring it from file
	// content (Monaco defaults this on, which would override the preference).
	detectIndentation: false,
	automaticLayout: true,
	scrollbar: {
		/*
		 * Monaco defaults this to true, meaning it calls preventDefault() on every
		 * wheel event over the editor - including when it has nothing to scroll.
		 * An editor embedded in a scrollable panel therefore swallows the wheel
		 * and the panel underneath cannot be scrolled past it.
		 *
		 * It shows up as "scrolling stops working after resizing", because before
		 * the resize the panel fits and nothing needs to scroll; enlarge the
		 * editor and it both creates the overflow and covers the area you would
		 * otherwise put the cursor to scroll.
		 *
		 * false = consume the wheel only when the editor can actually act on it,
		 * and let it bubble otherwise.
		 */
		alwaysConsumeMouseWheel: false,

		verticalScrollbarSize: SCROLLBAR_SIZE,
		horizontalScrollbarSize: SCROLLBAR_SIZE,
	},
	// Render suggestion/hover/context-menu widgets in a body-level overlay so they
	// are not clipped by editor containers with `overflow: hidden` + fixed height.
	fixedOverflowWidgets: true,
	autoIndent: "full",
	autoClosingBrackets: "always",
	autoClosingQuotes: "always",
	cursorSmoothCaretAnimation: "on",
} satisfies EditorOptions;

/**
 * The way out of the Tab trap, beside the editor that has one.
 *
 * Only while the editor holds focus: a keyboard user is told the chord at the
 * moment they need it, and the dozen editors in the app do not each carry a
 * standing badge over their content. Read-only editors never show it - they run
 * with `tabFocusMode` on, so Tab already leaves them and there is no trap to
 * advertise a way out of.
 *
 * Caps come from `chordKeys` and the `Kbd` primitive, like every other chord
 * this app puts on screen: a hand-rolled badge here would be a second spelling
 * of a modifier `lib/platform.ts` already spells per platform.
 *
 * Not `UrlBar`'s `Hint`, which is the app's other chord-on-focus pattern: that
 * one is a Radix `Tooltip` around a `TooltipTrigger asChild`, and Monaco's
 * `<Editor>` is not a ref-forwarding child a trigger can attach to. The shape
 * here is instead the floating-surface one every popover uses - `bg-popover`,
 * a border, a shadow.
 *
 * The border is not decoration and not `border-rule`. This chip is the one
 * surface in the app that floats over *Monaco's* canvas rather than over a
 * declared app surface, so there is no `--rule` to inherit and it would fall
 * back to the invisible default. The fill cannot separate it either: Monaco's
 * dark background is #1e1e1e against a `--popover` of #1a1a1f, and both are
 * white in light. `border-border-strong` is the edge that reads on both, and
 * it is the token `Kbd` itself is built from.
 */
function LeaveEditorHint() {
	return (
		<div className="pointer-events-none absolute bottom-1.5 right-3 z-10 flex items-center gap-1 rounded-md border border-border-strong bg-popover px-1.5 py-1 text-popover-foreground shadow-md">
			<span className="text-[10px] leading-none text-muted-foreground">Leave editor</span>
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
	 * What this editor is, for a screen reader - "Request body", "Test script".
	 *
	 * Required rather than optional, and per call site rather than derived from
	 * `language`: two editors can share a language and never the same job (the
	 * GraphQL variables pane and the request body are both `json`), and a dozen
	 * panes all announcing Monaco's default "Editor content" is the same as none
	 * of them announcing anything. `code-editor.aria-label.test.tsx` holds the
	 * labels distinct; the type holds them present.
	 */
	ariaLabel: string;
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
	onChange,
	height = "100%",
	readOnly = false,
	fontSize,
	options,
	className,
	onMount,
}: CodeEditorProps) {
	const isDark = useDarkMode();
	const editor = useClientSettingsStore((s) => s.editor);
	const monoStack = useClientSettingsStore(selectMonoStack);
	const monaco = useLoadedMonaco();
	const [loadFailed, setLoadFailed] = useState(false);
	const [hasFocus, setHasFocus] = useState(false);

	useEffect(() => {
		let active = true;
		void ensureMonaco().catch((error: unknown) => {
			// Loud, not silent: without this the skeleton below would sit there
			// forever looking like a slow load.
			console.error("Monaco failed to load", error);
			if (active) setLoadFailed(true);
		});
		return () => {
			active = false;
		};
	}, []);

	/*
	 * Every editor gets the window chords Monaco would otherwise eat, here
	 * rather than at each call site: it is the wrapper's job to make an editor
	 * behave like the rest of the app, and there are a dozen of them (#938).
	 * The caller's own `onMount` still runs.
	 */
	const handleMount = useCallback<OnMount>(
		(instance, monaco) => {
			registerEditorChords(instance, monaco);
			onMount?.(instance, monaco);
		},
		[onMount]
	);

	// User editor preferences override the shared defaults; an explicit
	// `fontSize` prop still wins over the preference, and per-call `options`
	// win over everything.
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
			<div
				role="alert"
				style={{ height }}
				className={cn(
					"flex items-center justify-center p-3 text-xs text-destructive-text",
					className
				)}
			>
				Editor failed to load. Reopen the app to try again.
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
		 * The wrapper exists for the hint, which has to be positioned against the
		 * editor's own box. `className` and `height` stay on it rather than on
		 * `<Editor>` so every call site's layout reads exactly as it did - and so
		 * the two states above, which already render their own box, keep the same
		 * shape as this one.
		 */
		<div
			className={cn("relative", className)}
			style={{ height }}
			onFocus={() => setHasFocus(true)}
			onBlur={(e) => {
				// Monaco moves focus between its own nodes (the hidden textarea, the
				// find widget); only focus leaving the editor entirely counts.
				if (!e.currentTarget.contains(e.relatedTarget)) setHasFocus(false);
			}}
		>
			<Editor
				height="100%"
				language={language}
				value={value}
				theme={isDark ? "vs-dark" : "vs"}
				onChange={onChange ? (v) => onChange(v ?? "") : undefined}
				onMount={handleMount}
				options={{
					...DEFAULT_OPTIONS,
					...prefOptions,
					readOnly,
					ariaLabel,
					/*
					 * Tab moves focus in an editor nobody can type into: there is no
					 * indentation to insert, so Monaco's default is a keyboard trap
					 * (WCAG 2.1.2) with nothing on the other side of it. The editable
					 * editors keep Tab and get `LEAVE_EDITOR_CHORD` plus the hint above.
					 */
					tabFocusMode: readOnly,
					...options,
					// `scrollbar` is a nested object, so a caller passing one of its keys
					// would otherwise replace the whole thing and silently drop the
					// wheel-propagation default above. Merge it a level deeper.
					scrollbar: { ...DEFAULT_OPTIONS.scrollbar, ...options?.scrollbar },
				}}
			/>
			{!readOnly && hasFocus && <LeaveEditorHint />}
		</div>
	);
}
