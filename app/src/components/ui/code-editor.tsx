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

import { Editor, type EditorProps, type OnMount } from "@monaco-editor/react";

type EditorOptions = NonNullable<EditorProps["options"]>;

/** Monaco theme used across the app. Change here to retheme every editor. */
const EDITOR_THEME = "vs-dark";

/** Options shared by every editor instance. */
const DEFAULT_OPTIONS = {
	minimap: { enabled: false },
	lineNumbers: "on",
	scrollBeyondLastLine: false,
	wordWrap: "on",
	tabSize: 2,
	automaticLayout: true,
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
	fontSize = 13,
	options,
	className,
	onMount,
}: CodeEditorProps) {
	return (
		<Editor
			className={className}
			height={height}
			language={language}
			value={value}
			theme={EDITOR_THEME}
			onChange={onChange ? (v) => onChange(v ?? "") : undefined}
			onMount={onMount}
			options={{ ...DEFAULT_OPTIONS, readOnly, fontSize, ...options }}
		/>
	);
}
