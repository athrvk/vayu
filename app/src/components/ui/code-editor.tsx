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
 */

import { useState, useEffect } from "react";
import { Editor, type EditorProps, type OnMount } from "@monaco-editor/react";
import { useClientSettingsStore } from "@/stores";
import { selectMonoStack } from "@/stores/client-settings-store";

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
		 * wheel event over the editor — including when it has nothing to scroll.
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
	},
	// Render suggestion/hover/context-menu widgets in a body-level overlay so they
	// are not clipped by editor containers with `overflow: hidden` + fixed height.
	fixedOverflowWidgets: true,
	autoIndent: "full",
	autoClosingBrackets: "always",
	autoClosingQuotes: "always",
} satisfies EditorOptions;

export interface CodeEditorProps {
	value: string;
	language: string;
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

	return (
		<Editor
			className={className}
			height={height}
			language={language}
			value={value}
			theme={isDark ? "vs-dark" : "vs"}
			onChange={onChange ? (v) => onChange(v ?? "") : undefined}
			onMount={onMount}
			options={{
				...DEFAULT_OPTIONS,
				...prefOptions,
				readOnly,
				...options,
				// `scrollbar` is a nested object, so a caller passing one of its keys
				// would otherwise replace the whole thing and silently drop the
				// wheel-propagation default above. Merge it a level deeper.
				scrollbar: { ...DEFAULT_OPTIONS.scrollbar, ...options?.scrollbar },
			}}
		/>
	);
}
