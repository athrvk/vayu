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
 */

import { useRef } from "react";
import type * as Monaco from "monaco-editor";
import { CodeEditor } from "@/components/ui";
import { ScriptSnippets } from "@/components/shared";
import { insertSnippetAtCursor } from "@/lib/editor-snippet";

export interface ScriptElementFormProps {
	kind: string;
	config: Record<string, unknown>;
	onChange: (config: Record<string, unknown>) => void;
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

	return (
		<div className="flex min-h-40 flex-col gap-2">
			<p className="text-xs text-muted-foreground">{isPre ? PRE_INTRO : POST_INTRO}</p>
			<div className="min-h-40 flex-1 rounded-md border border-rule surface-card bg-card overflow-hidden">
				<CodeEditor
					language="javascript"
					ariaLabel={isPre ? "Pre-request script" : "Test script"}
					value={script}
					onChange={(value) => onChange({ ...config, script: value ?? "" })}
					onMount={(instance) => {
						editorRef.current = instance;
					}}
				/>
			</div>
			<ScriptSnippets
				context={isPre ? "pre" : "test"}
				onInsert={(snippet) => insertSnippetAtCursor(editorRef.current, snippet)}
			/>
		</div>
	);
}
