/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The bespoke form for `script.pre` / `script.post` (issue #1512): the same
 * Monaco editor and insertable snippets the old Pre-request/Tests tabs gave a
 * script, instead of the generic form's plain text field a multi-line script
 * would otherwise get.
 *
 * Deliberately without the old `ScriptPanel`'s variable-reference chips,
 * inherited-scripts notice or legacy-run notice: those read
 * `useRequestBuilderContext`, which a primitive under `components/shared/`
 * cannot depend on - `ElementList` is used by the collection detail's
 * Elements tab too, which has no such context. Inheritance is shown once for
 * the whole list by `InheritedElementsNotice` instead of once per script row.
 *
 * **The editor box has a definite pixel height** (issue #1605). The element
 * card it sits in (`ElementRow`) is an auto-height block, not a bounded
 * ancestor a percentage or a `ResizablePanelGroup` could divide, so
 * `CodeEditor`'s default `height="100%"` used to resolve against nothing and
 * Monaco laid out at zero height. A drag handle below the box - the GraphQL
 * body's `ResizableHandle` styling, without the panel group it depends on -
 * sets that height directly, in `layout-store`'s `scriptEditorHeight`.
 *
 * **Each row's Snippets disclosure is its own `useState`**, seeded once from
 * the store's persisted default and written back to it on toggle. A request
 * or collection can show a `script.pre` and a `script.post` row on the same
 * screen; `ScriptSnippets` used to read the store's boolean directly, so
 * opening one opened both.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import { CodeEditor } from "@/components/ui";
import { ScriptSnippets } from "@/components/shared";
import { insertSnippetAtCursor } from "@/lib/editor-snippet";
import { useLayoutStore } from "@/stores";
import {
	SCRIPT_EDITOR_HEIGHT_STEP,
	SCRIPT_EDITOR_MAX_HEIGHT,
	SCRIPT_EDITOR_MIN_HEIGHT,
} from "@/constants/layout";
import { cn } from "@/lib/utils";

export interface ScriptElementFormProps {
	kind: string;
	config: Record<string, unknown>;
	onChange: (config: Record<string, unknown>) => void;
}

function clampHeight(height: number): number {
	return Math.max(SCRIPT_EDITOR_MIN_HEIGHT, Math.min(SCRIPT_EDITOR_MAX_HEIGHT, height));
}

/**
 * The persisted height save, debounced the way `GraphQLBody`'s
 * `handleVariablesResize` is: a drag fires on every pointer-move frame, and
 * the store writes through to localStorage.
 */
function useDebouncedHeightSave(save: (height: number) => void) {
	const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => () => clearTimeout(timeout.current ?? undefined), []);
	return useCallback(
		(height: number) => {
			if (timeout.current) clearTimeout(timeout.current);
			timeout.current = setTimeout(() => save(height), 200);
		},
		[save]
	);
}

/** Inline code in the intro sentence - a bare element, not a component. */
const CODE_CLASS = "bg-muted px-1 rounded-md";

const PRE_INTRO = (
	<>
		Execute JavaScript before sending the request. Use the{" "}
		<code className={CODE_CLASS}>pm</code> API. Edits to{" "}
		<code className={CODE_CLASS}>pm.request</code> change what is actually sent. Load tests do
		not run pre-request scripts at all - this one runs on Send and in a collection run.
	</>
);

const POST_INTRO = (
	<>
		Execute JavaScript after receiving the response. Use{" "}
		<code className={CODE_CLASS}>pm.test()</code> for assertions.{" "}
		<code className={CODE_CLASS}>pm.response.to</code> asserts about the response itself;{" "}
		<code className={CODE_CLASS}>pm.expect</code> asserts about any value you hand it.
	</>
);

export function ScriptElementForm({ kind, config, onChange }: ScriptElementFormProps) {
	const script = typeof config.script === "string" ? config.script : "";
	const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
	const isPre = kind === "script.pre";
	const editorLabel = isPre ? "Pre-request script" : "Test script";

	// One store value for every script row (like `graphqlVariablesSize`); a
	// drag on this row's handle previews locally so the box tracks the pointer
	// every frame, and the debounced save is what every other row picks up.
	const storedHeight = useLayoutStore((s) => s.scriptEditorHeight);
	const setStoredHeight = useLayoutStore((s) => s.setScriptEditorHeight);
	const saveHeight = useDebouncedHeightSave(setStoredHeight);
	const [dragHeight, setDragHeight] = useState<number | null>(null);
	const height = dragHeight ?? storedHeight;

	const startResize = (e: React.PointerEvent) => {
		e.currentTarget.setPointerCapture(e.pointerId);
		const startY = e.clientY;
		const startHeight = storedHeight;

		const onMove = (moveEvent: PointerEvent) => {
			const next = clampHeight(startHeight + (moveEvent.clientY - startY));
			setDragHeight(next);
			saveHeight(next);
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			setDragHeight(null);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};

	const onHandleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			saveHeight(clampHeight(storedHeight + SCRIPT_EDITOR_HEIGHT_STEP));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			saveHeight(clampHeight(storedHeight - SCRIPT_EDITOR_HEIGHT_STEP));
		}
	};

	// Per-row, not a `useLayoutStore` subscription: two script rows can be on
	// screen at once, and a shared boolean would expand or collapse both from
	// one click. Seeded once from the persisted default; the toggle writes
	// back to it so the *next* row a user opens starts where they left one.
	const [snippetsCollapsed, setSnippetsCollapsed] = useState(
		() => useLayoutStore.getState().scriptSnippetsCollapsed
	);
	const setScriptSnippetsCollapsed = useLayoutStore((s) => s.setScriptSnippetsCollapsed);
	const handleSnippetsCollapsedChange = (collapsed: boolean) => {
		setSnippetsCollapsed(collapsed);
		setScriptSnippetsCollapsed(collapsed);
	};

	return (
		<div className="flex flex-col gap-2">
			<p className="text-xs text-muted-foreground">{isPre ? PRE_INTRO : POST_INTRO}</p>
			<div className="flex flex-col">
				<div
					// `min-h-0`: the GraphQL body's own trap (`GraphQLBody.tsx:812-817`) -
					// a flex item will not shrink below its content, so a card that ever
					// gains a flex ancestor above this one must not let the editor keep
					// its old height and grow a second scrollbar beside Monaco's own.
					className="min-h-0 shrink-0 rounded-t-md border border-b-0 border-rule surface-card bg-card overflow-hidden"
					style={{ height }}
				>
					<CodeEditor
						language="javascript"
						ariaLabel={editorLabel}
						value={script}
						onChange={(value) => onChange({ ...config, script: value ?? "" })}
						onMount={(instance) => {
							editorRef.current = instance;
						}}
					/>
				</div>
				{/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- WAI-ARIA window splitter - a focusable `role="separator"` is its sanctioned interactive form, with the pointer drag and arrow-key handling below */}
				<div
					role="separator"
					aria-orientation="horizontal"
					aria-label={`${editorLabel} editor height`}
					aria-valuenow={Math.round(storedHeight)}
					aria-valuemin={SCRIPT_EDITOR_MIN_HEIGHT}
					aria-valuemax={SCRIPT_EDITOR_MAX_HEIGHT}
					tabIndex={0}
					onPointerDown={startResize}
					onKeyDown={onHandleKeyDown}
					className={cn(
						"h-1.5 w-full shrink-0 cursor-row-resize rounded-b-md border border-t-0 border-rule bg-rule transition-colors",
						"hover:bg-primary focus-visible:bg-primary focus-visible:outline-none"
					)}
				/>
			</div>
			<ScriptSnippets
				context={isPre ? "pre" : "test"}
				collapsed={snippetsCollapsed}
				onCollapsedChange={handleSnippetsCollapsedChange}
				onInsert={(snippet) => insertSnippetAtCursor(editorRef.current, snippet)}
			/>
		</div>
	);
}
