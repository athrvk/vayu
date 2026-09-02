/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * BodyPanel Component
 *
 * Mode selection, and whichever editor that mode needs: a code editor for JSON,
 * JSON-RPC, XML and text, the key/value table for form-data and urlencoded, and
 * `GraphQLBody` for GraphQL.
 *
 * **XML is a plain code pane too.** SOAP and legacy-enterprise APIs are HTTP
 * plus an XML document the user writes whole, so the mode buys highlighting
 * (Monaco's `xml` basic language ships in the bundle already, for the response
 * viewer), the `{{` completion every other body language gets
 * (`BODY_LANGUAGES`, which this mode was missing from until #1214) and an
 * auto-`Content-Type: application/xml` - not an editor of its own. The engine
 * sends its content byte for byte, with no envelope of any kind.
 *
 * **JSON-RPC is a plain JSON pane, deliberately.** Its call is one JSON text -
 * the envelope around it (`"jsonrpc":"2.0"`, and an `id` when the call names
 * none) is completed engine-side at the chokepoint every client shares, so
 * there is nothing here for a structured editor to edit. That is the opposite
 * of GraphQL, whose query and variables are two documents the user writes
 * separately, and it is why this mode adds a `BODY_MODES` row and a language
 * rather than a component.
 *
 * **GraphQL used to live here**, and was roughly 40% of the file - the only
 * mode with an editor pair, an introspection lifecycle and a header side effect
 * of its own. It is its own component now.
 *
 * **Choosing GraphQL still adds a Content-Type header, but says so - and
 * leaving GraphQL removes it again.** It used to write `Content-Type:
 * application/json` into `request.headers` in silence, on a tab you are not
 * looking at, and never take it back - so picking GraphQL once and returning to
 * None left the header behind for good, on a request that sends no body at all.
 * The header is genuinely required, so it is still added; what changed is that
 * the panel announces it, and that the next mode change takes back the row it
 * wrote (`body/content-type.ts`, by row id - a Content-Type the user typed is
 * indistinguishable by value and must survive).
 *
 * **The resolved preview swaps rather than splits.** It used to put the editor
 * and a read-only echo side by side at `grid-cols-2`, so the code you are
 * editing gave up half its width - about 250px each on a narrow response split.
 * A resolved body is something you glance at to confirm, not something you read
 * alongside, so the two share one full-width surface.
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { OnMount } from "@monaco-editor/react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Button,
	CodeEditor,
	Skeleton,
} from "@/components/ui";
import { useRequestBuilderContext } from "../../../context";
import KeyValueEditor from "@/components/shared/KeyValueEditor";
import { useVariableSupport } from "../../../hooks/useVariableSupport";
import type { BodyMode } from "../../../types";
import type { KeyValueItem } from "@/types";
import { createEmptyKeyValue } from "@/components/shared/KeyValueEditor/key-value";
import { toFlatHeaders } from "../../../utils/key-value";
import { containsVariableToken } from "@/constants/variables";
import { useResizable } from "@/hooks/useResizable";
import { useSessionStore } from "@/stores";
import type { SchemaTarget } from "@/lib/graphql/schema-cache";
import { cn } from "@/lib/utils";
import { BODY_MODES } from "./body/body-modes";
import { switchContentType, withoutContentType } from "./body/content-type";
import { ContentTypeNotice } from "./body/ContentTypeNotice";
import { ownVariablesDraft, switchBody } from "../../../utils/body-drafts";

/*
 * The GraphQL pane is the entry chunk's largest optional passenger: the
 * `graphql` package plus `graphql-language-service` and the variables schema
 * work, none of which a REST request ever touches. It renders only for
 * `bodyMode === "graphql"`, so it loads then (#1146).
 */
const GraphQLBody = lazy(() => import("./body/GraphQLBody"));

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
		// eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- WAI-ARIA window splitter - a focusable `role="separator"` is its sanctioned interactive form, with the arrow/Page/Home/End handling in the onKeyDown just below
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
	const {
		request,
		updateField,
		resolveString,
		getBodyDrafts,
		setBodyDrafts,
		getVariablesDraft,
		setVariablesDraft,
		getAutoContentType,
		setAutoContentType,
		resolvedAuth,
	} = useRequestBuilderContext();
	const variables = useVariableSupport();
	// The environment scoping GraphQL introspection's compose call - the same id
	// the builder's Send path passes.
	const activeEnvironmentId = useSessionStore((s) => s.activeEnvironmentId);
	const [showResolved, setShowResolved] = useState(false);

	/*
	 * The GraphQL Variables pane's text, held by the provider so it outlives this
	 * panel - Radix unmounts it on every glance at another tab. Stable identity,
	 * because `GraphQLBody` re-syncs the pane in an effect that depends on it.
	 */
	const handleVariablesDraftChange = useCallback(
		(text: string) => setVariablesDraft({ requestId: request.id ?? null, text }),
		[setVariablesDraft, request.id]
	);

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
	 * The Content-Type this mode change added, for the notice.
	 *
	 * Null once dismissed, undone, or the mode changes again - the notice is
	 * about the edit that just happened, not a standing state. *Which row* was
	 * added is remembered separately and durably (`getAutoContentType`), because
	 * removing it again must survive dismissing the notice and unmounting the
	 * panel.
	 */
	const [addedContentType, setAddedContentType] = useState<string | null>(null);

	/*
	 * What GraphQL introspection needs, unresolved: since #228 it composes
	 * engine-side, so the URL, the header rows and the auth block go over as
	 * typed and `POST /compose` resolves them - including an `inherit` that only
	 * the collection chain can settle, which is what an Auth-panel-authed
	 * endpoint needs to answer introspection at all.
	 *
	 * `resolvedUrl` and `resolvedAuth` are the preview-resolved values here, and
	 * neither is sent: they identify the cache entry, so editing a variable the
	 * URL interpolates - or the credential the auth resolves to, wherever in the
	 * chain it lives - points at a different schema instead of reusing the old
	 * one.
	 */
	const gqlSchemaTarget: SchemaTarget = {
		url: (request.url || "").trim(),
		resolvedUrl: resolveString(request.url || "").trim(),
		headers: toFlatHeaders(request.headers),
		auth: { ...request.auth },
		resolvedAuth,
		collectionId: request.collectionId || undefined,
		environmentId: activeEnvironmentId || undefined,
	};

	const handleModeChange = (mode: BodyMode) => {
		/*
		 * What each kind of body held, so switching mode does not destroy it.
		 *
		 * JSON, text and GraphQL all share `request.body` - the stored shape is
		 * one discriminated union - so switching handed the same string to a
		 * different reader. From JSON to GraphQL that meant the payload was read
		 * as a raw query, and one keystroke later the body was
		 * `{"query":"{\"merchant\":\"mrc_8813\"}"}` with the original gone.
		 *
		 * The drafts belong to the provider, not to this panel: Radix unmounts an
		 * inactive `TabsContent`, so a panel-local ref would be discarded every
		 * time you glanced at the Headers tab.
		 */
		const { body, drafts } = switchBody(
			request.bodyMode,
			mode,
			request.body ?? "",
			request.id,
			getBodyDrafts()
		);
		setBodyDrafts(drafts);
		if (body !== (request.body ?? "")) updateField("body", body);

		updateField("bodyMode", mode);

		// Initialize appropriate data for mode
		if (mode === "form-data" && request.formData.length === 0) {
			updateField("formData", [createEmptyKeyValue()]);
		}
		if (mode === "x-www-form-urlencoded" && request.urlEncoded.length === 0) {
			updateField("urlEncoded", [createEmptyKeyValue()]);
		}

		/*
		 * The mode may require a Content-Type, and the mode being left may have
		 * required one this panel added. Adding it automatically is right - GraphQL
		 * genuinely needs one - but doing so *silently*, to a tab the user is not
		 * looking at, was not, and nothing ever removed it: one visit to GraphQL
		 * left the header on the request permanently, including after switching
		 * back to None, which sends no body at all. Both halves happen in one call
		 * because they read and write the same array.
		 */
		const contentType = switchContentType(
			mode,
			request.headers,
			request.id,
			getAutoContentType()
		);
		if (contentType.headers !== request.headers) updateField("headers", contentType.headers);
		setAutoContentType(contentType.auto);
		setAddedContentType(contentType.added);
	};

	const undoContentType = () => {
		const auto = getAutoContentType();
		if (!auto) return;
		updateField("headers", withoutContentType(request.headers, auto));
		setAutoContentType(null);
		setAddedContentType(null);
	};

	const activeMode = BODY_MODES.find((m) => m.value === request.bodyMode);
	const hasVariables = containsVariableToken(request.body);
	const resolvedBody = request.body ? resolveString(request.body) : "";
	const isCodeMode =
		request.bodyMode === "json" ||
		request.bodyMode === "text" ||
		request.bodyMode === "jsonrpc" ||
		request.bodyMode === "xml";
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
								language={
									request.bodyMode === "json" || request.bodyMode === "jsonrpc"
										? "json"
										: request.bodyMode === "xml"
											? "xml"
											: "plaintext"
								}
								ariaLabel="Request body"
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
						<Suspense
							fallback={
								<div
									className="h-full w-full p-2"
									role="status"
									aria-label="Loading GraphQL editor"
								>
									<Skeleton className="h-full w-full rounded-md" />
								</div>
							}
						>
							<GraphQLBody
								body={request.body || ""}
								onBodyChange={(b) => updateField("body", b)}
								requestId={request.id ?? null}
								schemaTarget={gqlSchemaTarget}
								onEditorMount={handleEditorMount}
								variablesDraft={ownVariablesDraft(
									getVariablesDraft(),
									request.id ?? null
								)}
								onVariablesDraftChange={handleVariablesDraftChange}
							/>
						</Suspense>
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
					// Only multipart can carry a file: urlencoded's wire body is a
					// string of pairs, and the engine refuses a file part there.
					allowFiles={request.bodyMode === "form-data"}
					variables={variables}
				/>
			)}
		</div>
	);
}
