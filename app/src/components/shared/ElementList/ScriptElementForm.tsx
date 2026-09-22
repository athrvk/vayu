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
 * ancestor a percentage or a `ResizablePanelGroup` could divide. `Group`
 * (`react-resizable-panels`, `components/ui/resizable.tsx`) sizes a panel
 * with `flex-grow` against the group's own measured `getBoundingClientRect`
 * (v4 does take a pixel `minSize`/`maxSize`/`resize()`, but those are still
 * validated against that same measured total) - so it can constrain a
 * *share* of a definite total, never set one, which is exactly what this
 * box's own absolute, unbounded-parent height needs. A drag handle below the
 * box sets the height directly, in `layout-store`'s `scriptEditorHeights`,
 * through `useResizeGesture` (issue #1715) - the same rAF-coalesced-write,
 * one-commit-on-release mechanism `PanelResizeHandle` uses for the drawer
 * and context bar widths, extracted into a shared hook (issue #1738) rather
 * than left as two independently-drifting copies: this row's keyboard
 * handling now matches `PanelResizeHandle`'s (Page keys, Home/End, a reset),
 * and both copies now abort a `pointercancel`'d drag instead of leaving it
 * uncommitted with its listeners still attached.
 *
 * **That height is per element id, not shared across every script row**
 * (issue #1643). A request or collection can show a `script.pre` and a
 * `script.post` card at once - each a different element - and the store used
 * to hold one number for all of them, so dragging either row's handle
 * resized both. This form is handed the owning element's `id` and reads/
 * writes that row's own entry in `scriptEditorHeights`, falling back to
 * `scriptEditorHeightDefault` - a *mount-time* snapshot, not a live
 * subscription - for a row that has never been dragged, so that default
 * updating (any row's drag writes it too) never retroactively resizes an
 * already-mounted row that has its own entry.
 *
 * **Each row's Snippets disclosure is its own `useState`**, seeded once from
 * the store's persisted default and written back to it on toggle. A request
 * or collection can show a `script.pre` and a `script.post` row on the same
 * screen; `ScriptSnippets` used to read the store's boolean directly, so
 * opening one opened both.
 *
 * **The intro sentence is the kind's own `description`** (issue #1608), not
 * a hard-coded pair of strings here - `script.pre` and `script.post`'s
 * catalogue descriptions absorbed that explanatory text in issue #1607, so
 * it is authored once and reused as both the card's collapsed summary
 * fallback and this form's lead line.
 */

import { useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import { CodeEditor } from "@/components/ui";
import { ScriptSnippets } from "@/components/shared";
import { insertSnippetAtCursor } from "@/lib/editor-snippet";
import { useResizeGesture } from "@/lib/resize-gesture";
import { useLayoutStore } from "@/stores";
import {
	DEFAULT_SCRIPT_EDITOR_HEIGHT,
	SCRIPT_EDITOR_HEIGHT_PAGE_STEP,
	SCRIPT_EDITOR_HEIGHT_STEP,
	SCRIPT_EDITOR_MAX_HEIGHT,
	SCRIPT_EDITOR_MIN_HEIGHT,
} from "@/constants/layout";
import { cn } from "@/lib/utils";

export interface ScriptElementFormProps {
	/** The owning element's own id - the key into `scriptEditorHeights` (issue #1643). */
	id: string;
	kind: string;
	config: Record<string, unknown>;
	/** The kind's own catalogue description - the form's lead sentence. */
	description: string;
	onChange: (config: Record<string, unknown>) => void;
}

export function ScriptElementForm({
	id,
	kind,
	config,
	description,
	onChange,
}: ScriptElementFormProps) {
	const script = typeof config.script === "string" ? config.script : "";
	const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
	const isPre = kind === "script.pre";
	const editorLabel = isPre ? "Pre-request script" : "Test script";

	// This row's own entry, if it has ever been dragged - a live subscription,
	// so a drag on *this* row's handle re-renders it. The fallback default is
	// a mount-time snapshot instead (the same `useState(() => store.getState()
	// .x)` shape `scriptSnippetsCollapsed` below uses): a live subscription to
	// the default would mean dragging one never-touched row's handle
	// retroactively resized every *other* never-touched row still mounted,
	// which is the same bug this store shape exists to fix, one level down.
	const ownHeight = useLayoutStore((s) => s.scriptEditorHeights[id]);
	const [mountDefault] = useState(() => useLayoutStore.getState().scriptEditorHeightDefault);
	const storedHeight = ownHeight ?? mountDefault;
	const setStoredHeight = useLayoutStore((s) => s.setScriptEditorHeight);

	const boxRef = useRef<HTMLDivElement | null>(null);
	const gesture = useResizeGesture({
		min: SCRIPT_EDITOR_MIN_HEIGHT,
		max: SCRIPT_EDITOR_MAX_HEIGHT,
		getValue: () => storedHeight,
		commit: (height) => setStoredHeight(id, height),
		paint: (height) => {
			if (boxRef.current) boxRef.current.style.height = `${height}px`;
		},
	});

	const onHandleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		const nudge = (delta: number) => {
			e.preventDefault();
			gesture.applyKey(e, gesture.currentValue() + delta);
		};
		const jumpTo = (target: number) => {
			e.preventDefault();
			gesture.applyKey(e, target);
		};

		switch (e.key) {
			case "ArrowDown":
				return nudge(SCRIPT_EDITOR_HEIGHT_STEP);
			case "ArrowUp":
				return nudge(-SCRIPT_EDITOR_HEIGHT_STEP);
			case "PageDown":
				return nudge(SCRIPT_EDITOR_HEIGHT_PAGE_STEP);
			case "PageUp":
				return nudge(-SCRIPT_EDITOR_HEIGHT_PAGE_STEP);
			case "Home":
				return jumpTo(SCRIPT_EDITOR_MIN_HEIGHT);
			case "End":
				return jumpTo(SCRIPT_EDITOR_MAX_HEIGHT);
			case "Enter":
			case " ":
				e.preventDefault();
				gesture.applyKey(e, DEFAULT_SCRIPT_EDITOR_HEIGHT);
				return;
			default:
				return;
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
			<p className="text-xs text-muted-foreground">{description}</p>
			<div className="flex flex-col">
				<div
					ref={boxRef}
					// `min-h-0`: the GraphQL body's own trap (`GraphQLBody.tsx:812-817`) -
					// a flex item will not shrink below its content, so a card that ever
					// gains a flex ancestor above this one must not let the editor keep
					// its old height and grow a second scrollbar beside Monaco's own.
					className="min-h-0 shrink-0 rounded-t-md border border-b-0 border-rule surface-card bg-card overflow-hidden"
					style={{ height: storedHeight }}
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
					onPointerDown={(e) => gesture.startDrag(e, "y")}
					onKeyDown={onHandleKeyDown}
					onKeyUp={gesture.flushKey}
					onBlur={gesture.flushKey}
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
