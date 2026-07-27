/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * BodyPanel Component
 *
 * Mode selection, and whichever editor that mode needs: a code editor for JSON
 * and text, the key/value table for form-data and urlencoded, and `GraphQLBody`
 * for GraphQL.
 *
 * **GraphQL used to live here**, and was roughly 40% of the file - the only
 * mode with an editor pair, an introspection lifecycle and a header side effect
 * of its own. It is its own component now.
 *
 * **Choosing GraphQL still adds a Content-Type header, but says so.** It used
 * to write `Content-Type: application/json` into `request.headers` in silence,
 * on a tab you are not looking at, and never take it back - so picking GraphQL
 * once and returning to None left the header behind for good. The header is
 * genuinely required, so it is still added; what changed is that the panel
 * announces it and offers the way back.
 *
 * **The resolved preview swaps rather than splits.** It used to put the editor
 * and a read-only echo side by side at `grid-cols-2`, so the code you are
 * editing gave up half its width - about 250px each on a narrow response split.
 * A resolved body is something you glance at to confirm, not something you read
 * alongside, so the two share one full-width surface.
 */

import { useEffect, useRef, useState } from "react";
import type { OnMount } from "@monaco-editor/react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Button,
	CodeEditor,
} from "@/components/ui";
import { useRequestBuilderContext } from "../../../context";
import KeyValueEditor from "../../../shared/KeyValueEditor";
import type { BodyMode, KeyValueItem } from "../../../types";
import { createEmptyKeyValue, toFlatHeaders } from "../../../utils/key-value";
import { useResizable } from "@/hooks/useResizable";
import { cn } from "@/lib/utils";
import GraphQLBody from "./body/GraphQLBody";
import { contentTypeToAdd, contentTypeRow, withoutContentType } from "./body/content-type";
import { ContentTypeNotice } from "./body/ContentTypeNotice";
import { switchBody, emptyDrafts, type BodyDrafts } from "./body/body-drafts";

const BODY_MODES: { value: BodyMode; label: string; contentType: string | null }[] = [
	{ value: "none", label: "None", contentType: null },
	{ value: "json", label: "JSON", contentType: "application/json" },
	{ value: "text", label: "Text", contentType: "text/plain" },
	{ value: "graphql", label: "GraphQL", contentType: "application/json" },
	{ value: "form-data", label: "Form Data", contentType: "multipart/form-data" },
	{
		value: "x-www-form-urlencoded",
		label: "URL Encoded",
		contentType: "application/x-www-form-urlencoded",
	},
];

/** One arrow press. A shade over a text line, so it moves visibly. */
const RESIZE_STEP = 24;

/**
 * The handle that resizes the whole editor.
 *
 * It was `role="separator"` with an `onMouseDown` and nothing else: not
 * focusable, no key handling, so the editor's height was mouse-only. A
 * focusable separator is a window splitter, and the keys below are that
 * pattern - arrows to nudge, Page keys for a coarse jump, Home/End for the
 * extremes (which `resizeBy` handles via ±Infinity, since it clamps).
 *
 * It carries a **grip**, and the GraphQL query/variables splitter inside the box
 * is a hairline. The two used to be identical - both `h-1.5 bg-border
 * hover:bg-primary cursor-row-resize` - so a GraphQL body showed two matching
 * grey bars doing different jobs. The grip is the same one the request/response
 * splitter uses, and it says "this whole thing" rather than "this seam".
 */
function ResizeHandle({
	onMouseDown,
	onResize,
	active,
	size,
	min,
	max,
}: {
	onMouseDown: (e: React.MouseEvent) => void;
	onResize: (delta: number) => void;
	active: boolean;
	size: number;
	min: number;
	max: number;
}) {
	return (
		<div
			role="separator"
			aria-orientation="horizontal"
			aria-label="Resize editor"
			aria-valuenow={Math.round(size)}
			aria-valuemin={min}
			aria-valuemax={max}
			tabIndex={0}
			onMouseDown={onMouseDown}
			onKeyDown={(e) => {
				const step =
					e.key === "ArrowUp" || e.key === "PageUp"
						? -1
						: e.key === "ArrowDown" || e.key === "PageDown"
							? 1
							: 0;
				if (step !== 0) {
					// Otherwise the panel scrolls under the handle as it moves.
					e.preventDefault();
					const coarse = e.key === "PageUp" || e.key === "PageDown";
					onResize(step * RESIZE_STEP * (coarse ? 4 : 1));
					return;
				}
				if (e.key === "Home" || e.key === "End") {
					e.preventDefault();
					onResize(e.key === "Home" ? -Infinity : Infinity);
				}
			}}
			className={cn(
				"group flex h-3 cursor-row-resize items-center justify-center",
				"focus-visible:outline-none"
			)}
		>
			<div
				className={cn(
					"h-1 w-7 rounded-full bg-border-strong transition-colors",
					"group-hover:bg-primary group-focus-visible:bg-primary",
					active && "bg-primary"
				)}
			/>
		</div>
	);
}

export default function BodyPanel() {
	const { request, updateField, resolveString } = useRequestBuilderContext();
	const [showResolved, setShowResolved] = useState(false);

	// Drag-to-resize editor height, shared across body modes that host an editor.
	const {
		size: editorHeight,
		isResizing,
		startResizing,
		resizeBy,
		min: editorMin,
		max: editorMax,
	} = useResizable({ defaultSize: 320, min: 160, max: 800, direction: "vertical" });

	// Monaco's automaticLayout doesn't reliably catch the container shrinking via
	// the drag handle, leaving the editor's viewport stuck at its old height (so
	// scrolling appears broken). Relayout every mounted editor when the height
	// changes.
	const editorsRef = useRef(new Set<Parameters<OnMount>[0]>());
	const handleEditorMount: OnMount = (editorInstance) => {
		editorsRef.current.add(editorInstance);
		editorInstance.onDidDispose(() => editorsRef.current.delete(editorInstance));
	};
	useEffect(() => {
		for (const editorInstance of editorsRef.current) editorInstance.layout();
	}, [editorHeight]);

	/*
	 * The Content-Type this mode change added, so it can be taken back.
	 *
	 * Null once dismissed, undone, or the mode changes again - the notice is
	 * about the edit that just happened, not a standing state.
	 */
	const [addedContentType, setAddedContentType] = useState<string | null>(null);

	const resolvedGqlUrl = resolveString(request.url || "").trim();
	const buildResolvedHeaders = (): Record<string, string> =>
		Object.fromEntries(
			Object.entries(toFlatHeaders(request.headers)).map(([k, v]) => [
				resolveString(k),
				resolveString(v),
			])
		);

	/*
	 * What each kind of body held, so switching mode does not destroy it.
	 *
	 * JSON, text and GraphQL all share `request.body` - the stored shape is one
	 * discriminated union - so switching handed the same string to a different
	 * reader. From JSON to GraphQL that meant the payload was read as a raw
	 * query, and one keystroke later the body was
	 * `{"query":"{\"merchant\":\"mrc_8813\"}"}` with the original gone.
	 *
	 * A ref rather than state: nothing renders from it, and it must not cause a
	 * re-render when stashed mid-switch.
	 *
	 * This panel is *not* remounted when you switch request tab - the provider
	 * resets its state in an effect instead - so the ref outlives the request it
	 * was filled for. The drafts therefore carry `requestId` and `switchBody`
	 * drops any that belong to a different one.
	 */
	const draftsRef = useRef<BodyDrafts>(emptyDrafts(request.id));

	const handleModeChange = (mode: BodyMode) => {
		const { body, drafts } = switchBody(
			request.bodyMode,
			mode,
			request.body ?? "",
			request.id,
			draftsRef.current
		);
		draftsRef.current = drafts;
		if (body !== (request.body ?? "")) updateField("body", body);

		updateField("bodyMode", mode);
		setAddedContentType(null);

		// Initialize appropriate data for mode
		if (mode === "form-data" && request.formData.length === 0) {
			updateField("formData", [createEmptyKeyValue()]);
		}
		if (mode === "x-www-form-urlencoded" && request.urlEncoded.length === 0) {
			updateField("urlEncoded", [createEmptyKeyValue()]);
		}

		/*
		 * The mode may require a Content-Type. Adding it automatically is right -
		 * GraphQL genuinely needs one - but doing so *silently*, to a tab the user
		 * is not looking at, was not, and nothing ever removed it, so one visit to
		 * this mode left the header on the request permanently.
		 */
		const required = contentTypeToAdd(mode, request.headers);
		if (required) {
			updateField("headers", [...request.headers, contentTypeRow(required)]);
			setAddedContentType(required);
		}
	};

	const undoContentType = () => {
		if (!addedContentType) return;
		updateField("headers", withoutContentType(request.headers, addedContentType));
		setAddedContentType(null);
	};

	const activeMode = BODY_MODES.find((m) => m.value === request.bodyMode);
	const hasVariables = request.body ? /\{\{[^{}]+\}\}/.test(request.body) : false;
	const resolvedBody = request.body ? resolveString(request.body) : "";
	const isCodeMode = request.bodyMode === "json" || request.bodyMode === "text";
	const isTable =
		request.bodyMode === "form-data" || request.bodyMode === "x-www-form-urlencoded";
	const tableItems = request.bodyMode === "form-data" ? request.formData : request.urlEncoded;
	const onTableChange = (items: KeyValueItem[]) =>
		updateField(request.bodyMode === "form-data" ? "formData" : "urlEncoded", items);

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between gap-3">
				<div className="flex items-center gap-2 min-w-0">
					<Select value={request.bodyMode} onValueChange={handleModeChange}>
						<SelectTrigger className="h-8 w-auto">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{BODY_MODES.map((mode) => (
								<SelectItem key={mode.value} value={mode.value}>
									{mode.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>

					{/*
					 * What actually goes on the wire, beside the picker. It used to
					 * appear only *inside* the dropdown, so once a mode was chosen the
					 * content type it implies was one click away and invisible the rest
					 * of the time.
					 */}
					{activeMode?.contentType ? (
						<code className="truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
							{activeMode.contentType}
						</code>
					) : (
						<span className="text-xs text-muted-foreground">No body will be sent.</span>
					)}
				</div>

				{/*
				 * Source / Resolved, as a swap. Only offered when the body actually
				 * contains a variable - there is nothing to resolve otherwise.
				 */}
				{hasVariables && isCodeMode && (
					<div className="flex shrink-0 items-center gap-1">
						<Button
							size="sm"
							variant={showResolved ? "ghost" : "secondary"}
							onClick={() => setShowResolved(false)}
							className="h-7 px-2.5 text-xs"
						>
							Source
						</Button>
						<Button
							size="sm"
							variant={showResolved ? "secondary" : "ghost"}
							onClick={() => setShowResolved(true)}
							className="h-7 px-2.5 text-xs"
						>
							Resolved
						</Button>
					</div>
				)}
			</div>

			{/* `/10` and `/30`, matching the accent tint the Load Test button and the
			    variable popover already use - not a bespoke opacity. */}
			{addedContentType && (
				<ContentTypeNotice
					value={addedContentType}
					onUndo={undoContentType}
					onDismiss={() => setAddedContentType(null)}
				/>
			)}

			{isCodeMode && (
				<div>
					<div
						className="overflow-hidden rounded-md border border-input"
						style={{ height: editorHeight }}
					>
						{showResolved ? (
							<pre className="h-full overflow-auto whitespace-pre-wrap bg-muted/50 p-3 font-mono text-sm">
								{resolvedBody || (
									<span className="italic text-muted-foreground">Empty body</span>
								)}
							</pre>
						) : (
							<CodeEditor
								height="100%"
								language={request.bodyMode === "json" ? "json" : "plaintext"}
								value={request.body || ""}
								onChange={(v) => updateField("body", v ?? "")}
								onMount={handleEditorMount}
							/>
						)}
					</div>
					<ResizeHandle
						onMouseDown={startResizing}
						onResize={resizeBy}
						active={isResizing}
						size={editorHeight}
						min={editorMin}
						max={editorMax}
					/>
				</div>
			)}

			{request.bodyMode === "graphql" && (
				<div>
					<div
						className="overflow-hidden rounded-md border border-input"
						style={{ height: editorHeight }}
					>
						<GraphQLBody
							body={request.body || ""}
							onBodyChange={(b) => updateField("body", b)}
							resolvedUrl={resolvedGqlUrl}
							resolvedHeaders={buildResolvedHeaders}
							onEditorMount={handleEditorMount}
							active
						/>
					</div>
					<ResizeHandle
						onMouseDown={startResizing}
						onResize={resizeBy}
						active={isResizing}
						size={editorHeight}
						min={editorMin}
						max={editorMax}
					/>
				</div>
			)}

			{/*
			 * form-data and urlencoded render through one branch. They were two
			 * copies of the same call, differing only in that one was wrapped in a
			 * `space-y-2` div and the other was not.
			 */}
			{isTable && (
				<KeyValueEditor
					items={tableItems.length > 0 ? tableItems : [createEmptyKeyValue()]}
					onChange={onTableChange}
					keyPlaceholder="Key"
					valuePlaceholder="Value"
					showResolved={true}
					allowDisable={true}
				/>
			)}
		</div>
	);
}
