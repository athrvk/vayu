/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Mode selection and the editor the mode needs: a code editor for JSON, JSON-RPC, MCP, XML and
 * text, the key/value table for form-data and urlencoded, `GraphQLBody` for GraphQL, and
 * `BinaryBodyPanel` for a whole-file body.
 *
 * - **XML is a plain code pane.** SOAP and legacy APIs are HTTP plus an XML document written whole,
 *   so the mode buys highlighting (Monaco's `xml` language is already bundled for the response
 *   viewer), the `{{` completion every body language gets (`BODY_LANGUAGES`, #1214) and an
 *   automatic `Content-Type: application/xml`. The engine sends it byte for byte, no envelope.
 * - **JSON-RPC is a plain JSON pane, deliberately.** The call is one JSON text; the envelope
 *   (`"jsonrpc":"2.0"`, and an `id` when none is named) is completed engine-side at the chokepoint
 *   every client shares, so a structured editor has nothing to edit. GraphQL is the opposite (two
 *   documents), which is why this mode is a `BODY_MODES` row and a language, not a component.
 * - **MCP is that JSON pane with a tool above it** (`McpToolFields`): the engine completes the call
 *   and derives every MCP header, so the mode adds the tool its `Mcp-Param-*` headers are read
 *   from, and a note on where the derived headers appear.
 * - **GraphQL adds a Content-Type header, says so, and leaving GraphQL removes it.** The header is
 *   required; the next mode change takes back the row it wrote (`body/content-type.ts`, by row id,
 *   since a typed Content-Type is indistinguishable by value and must survive).
 * - **The resolved preview swaps rather than splits**: it is glanced at to confirm, not read
 *   alongside, so the two share one full-width surface.
 * - **The editor fills the pane**, a `flex-1` child with a `min-h-40` floor: the height a user
 *   wants comes from the request/response splitter, which persists. A fixed box left a tall window
 *   a third of an editor, and its drag handle forgot the height on a tab switch (Radix unmounts the
 *   inactive tab).
 */

import { lazy, Suspense, useCallback, useMemo, useState } from "react";
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
import { Callout } from "@/components/shared/Callout";
import { useVariableSupport } from "../../../hooks/useVariableSupport";
import type { BodyMode } from "../../../types";
import type { KeyValueEntry, KeyValueItem } from "@/types";
import { createEmptyKeyValue } from "@/components/shared/KeyValueEditor/key-value";
import { contentTypeExtra } from "@/components/shared/KeyValueEditor/ContentTypeCell";
import { toHeaderRows } from "../../../utils/key-value";
import { composePathParams, substitutePathVariables } from "../../../utils/path-variables";
import { resolveUrlTemplate } from "../../../utils/query-encoding";
import { containsVariableToken } from "@/constants/variables";
import { bodyFieldContext, refusalsText, type BoundField } from "@/lib/data-bind-escaping";
import { deferredNamesIn, deferredNote } from "@/lib/deferred-note";
import { useSessionStore } from "@/stores";
import type { SchemaTarget } from "@/lib/graphql/schema-cache";
import { graphqlOperationReference } from "@/lib/agent-reference";
import { useRequestQuery } from "@/queries";
import type { GraphQLBodyProps } from "./body/GraphQLBody";
import { BODY_MODES } from "./body/body-modes";
import { mountBodyDiagnostics } from "./body/body-diagnostics";
import { switchContentType, withoutContentType } from "./body/content-type";
import { switchGraphQLMethod } from "./body/graphql-method";
import { ContentTypeNotice } from "./body/ContentTypeNotice";
import McpToolFields from "./body/McpToolFields";
import BinaryBodyPanel from "./body/BinaryBodyPanel";
import { binaryContentType } from "./body/binary-content-type";
import { ownVariablesDraft, switchBody } from "../../../utils/body-drafts";
import { requestModelPath } from "../../../utils/editor-models";

/*
 * The GraphQL pane is the entry chunk's largest optional passenger (`graphql`,
 * `graphql-language-service`, the variables schema work), none of which REST touches. It renders
 * only for `bodyMode === "graphql"`, so it loads then (#1146).
 */
const LazyGraphQLBody = lazy(() => import("./body/GraphQLBody"));

/**
 * The GraphQL pane with its agent reference formatter. The line names the SAVED request, not the
 * draft, as `ExamplesPanel` does: the engine and the agent's tools do not know an unsaved rename. A
 * wrapper, not a hook in `BodyPanel`, so only GraphQL mode needs the query cache.
 */
function GraphQLBody(props: GraphQLBodyProps) {
	const { data: savedRequest } = useRequestQuery(props.requestId);
	const operationReference = useMemo(
		() =>
			savedRequest
				? (name: string) => graphqlOperationReference({ name }, savedRequest)
				: undefined,
		[savedRequest]
	);
	return <LazyGraphQLBody {...props} operationReference={operationReference} />;
}

/**
 * The editor's floor, as a class: a short window still gets a usable editor and the tab panel
 * scrolls the rest. No ceiling: the pane is it.
 */
const EDITOR_BOX = "min-h-40 flex-1 overflow-hidden rounded-md border border-input";

const NO_BODY: BoundField = { text: "", refusals: [] };
const NO_NAMES: readonly string[] = [];

export default function BodyPanel() {
	const {
		request,
		memoryKey,
		setRequest,
		updateField,
		resolveString,
		resolveField,
		getBodyDrafts,
		setBodyDrafts,
		getVariablesDraft,
		setVariablesDraft,
		resolvedAuth,
	} = useRequestBuilderContext();
	const variables = useVariableSupport();
	// The environment GraphQL introspection composes with: the id the builder's Send passes.
	const activeEnvironmentId = useSessionStore((s) => s.activeEnvironmentId);
	const [showResolved, setShowResolved] = useState(false);

	/*
	 * The GraphQL Variables text, held by the provider so it outlives this panel (Radix unmounts it
	 * on every glance elsewhere). Stable identity: `GraphQLBody` re-syncs the pane in an effect on
	 * it.
	 */
	const handleVariablesDraftChange = useCallback(
		(text: string) => setVariablesDraft({ requestId: request.id ?? null, text }),
		[setVariablesDraft, request.id]
	);

	/*
	 * The Content-Type this mode change added, for the notice. Null once dismissed, undone, or the
	 * mode changes again: the notice is about the edit that just happened. *Which row* was added is
	 * marked on the row itself (`source: "body-mode"`, `utils/auto-header.ts`), so it survives
	 * dismissal, unmount and reload.
	 */
	const [addedContentType, setAddedContentType] = useState<string | null>(null);

	/*
	 * Force-mounted, so a request switch does not remount this panel, and the two view states above
	 * would follow the user to the next request (#3666): the notice would be untrue and its Undo
	 * would remove that request's own Content-Type row. Reset during render, as the provider's
	 * per-request reset is, so a stale notice never paints.
	 */
	const [stateFor, setStateFor] = useState(memoryKey);
	if (stateFor !== memoryKey) {
		setStateFor(memoryKey);
		setShowResolved(false);
		setAddedContentType(null);
	}

	/*
	 * What GraphQL introspection needs, unresolved: it composes engine-side (#228), so the URL,
	 * header rows and auth go as typed and `POST /compose` resolves them, including an `inherit`
	 * only the chain can settle, which an Auth-panel-authed endpoint needs to answer introspection
	 * at all. `resolvedUrl` and `resolvedAuth` are preview-resolved and never sent: they key the
	 * cache, so editing a variable the URL uses, or the credential the auth resolves to, points at
	 * another schema.
	 *
	 * `resolvedUrl` is memoized on the URL text: a dynamic variable like `{{$randomInt}}` changes
	 * on every call (`lib/dynamic-variables.ts`), and `schemaCacheKey` folds it into the
	 * introspection key, so an unmemoized call changed the key every render, a refetch loop. A
	 * `useMemo`, not `lib/dynamic-variable-cache.ts`'s module cache as `ParamsPanel`'s "Sends" line
	 * uses: this panel is force-mounted from first visit (`RequestTabs/index.tsx`), so its memo
	 * survives tab switches, and only the builder going away unmounts it, taking `resolveString`
	 * and so that cache with it.
	 */
	// Path values substituted first, each resolved then encoded as compose does (#1764), then the
	// URL's tokens by the rule of the part they land in (#1773), so a changed `:name` value is a
	// new schema target, as a changed variable is. Memoized on the URL and path rows' text, not
	// `params`, so a query-row edit re-resolves nothing.
	const gqlUrl = request.url || "";
	const pathRowsText = JSON.stringify(composePathParams(request.params));
	const resolvedGqlUrl = useMemo(() => {
		const rows = JSON.parse(pathRowsText) as KeyValueEntry[];
		return resolveUrlTemplate(
			substitutePathVariables(gqlUrl, rows, resolveString),
			resolveString,
			{
				encode: true,
			}
		).trim();
	}, [gqlUrl, pathRowsText, resolveString]);
	const gqlSchemaTarget: SchemaTarget = {
		url: (request.url || "").trim(),
		params: request.params,
		resolvedUrl: resolvedGqlUrl,
		headers: toHeaderRows(request.headers),
		auth: { ...request.auth },
		resolvedAuth,
		collectionId: request.collectionId || undefined,
		environmentId: activeEnvironmentId || undefined,
	};

	const handleModeChange = (mode: BodyMode) => {
		/*
		 * What each kind of body held, so a mode switch does not destroy it. JSON, text and GraphQL
		 * share `request.body` (one discriminated union), so a switch handed the string to another
		 * reader: JSON to GraphQL read the payload as a raw query, and one keystroke later the body
		 * was `{"query":"{\"merchant\":\"mrc_8813\"}"}`, the original gone. The drafts are the
		 * provider's, not this panel's: Radix unmounts an inactive `TabsContent`, so a local ref
		 * would be lost on a glance at Headers.
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

		if (mode === "form-data" && request.formData.length === 0) {
			updateField("formData", [createEmptyKeyValue()]);
		}
		if (mode === "x-www-form-urlencoded" && request.urlEncoded.length === 0) {
			updateField("urlEncoded", [createEmptyKeyValue()]);
		}

		/*
		 * The new mode may need a Content-Type, and the one being left may have had one added here.
		 * Adding it is right (GraphQL needs one), but not silently on a tab the user is not
		 * watching, and it must be taken back: one visit to GraphQL otherwise left it for good,
		 * even on None, which sends no body. One call does both, since both read and write the same
		 * array.
		 */
		const contentType = switchContentType(mode, request.headers);
		if (contentType.headers !== request.headers) updateField("headers", contentType.headers);
		setAddedContentType(contentType.added);

		/*
		 * GraphQL on a GET differs (the document travels as query parameters, a mutation cannot be
		 * sent), and a new request is a GET (#1228). The method moves the same reversible way as
		 * the header, and back on the way out; `graphql-method.ts` is the rule, including why a
		 * user-chosen method is left alone both ways. Both fields write in one call, like the
		 * headers: `method` alone would leave a stale `methodSource` marking the user's next pick
		 * as GraphQL's.
		 */
		const graphqlMethod = switchGraphQLMethod(mode, request.method, request.methodSource);
		if (
			graphqlMethod.method !== request.method ||
			graphqlMethod.methodSource !== request.methodSource
		) {
			setRequest({ method: graphqlMethod.method, methodSource: graphqlMethod.methodSource });
		}
	};

	const undoContentType = () => {
		updateField("headers", withoutContentType(request.headers));
		setAddedContentType(null);
	};

	const activeMode = BODY_MODES.find((m) => m.value === request.bodyMode);
	// A binary body's type depends on the request, not on the mode.
	const binaryType =
		request.bodyMode === "binary"
			? binaryContentType(request.headers, request.binaryFile)
			: null;
	const wireContentType =
		binaryType && binaryType.from !== "extension"
			? binaryType.value
			: (activeMode?.contentType ?? null);
	const hasVariables = containsVariableToken(request.body);
	// Memoized as `resolvedGqlUrl` is, and a `useMemo` for its reason: an unmemoized call rerolled
	// every `{{$randomInt}}`-style value in the body each render. A picked row's cell is written as
	// the mode's bind writes it, escaped in a JSON string or XML (#2639).
	const resolvedBody = useMemo(
		() =>
			request.body
				? resolveField(request.body, bodyFieldContext(request.bodyMode, request.body))
				: NO_BODY,
		[request.body, request.bodyMode, resolveField]
	);
	// Masked at render, after the memo: the memo holds a dynamic value stable, and `maskSecrets`
	// reads secrets as of now (#1813). Only the preview needs it, so Source builds no masker.
	const shownResolvedBody =
		showResolved && variables.maskSecrets
			? variables.maskSecrets(resolvedBody.text)
			: resolvedBody.text;
	// Names a pre-request script sets at send that the body uses: Resolved leaves them written
	// (`resolveField`) and says why (#2762).
	const deferredInBody = deferredNamesIn(variables.deferredVariables ?? NO_NAMES, [request.body]);
	const isCodeMode =
		request.bodyMode === "json" ||
		request.bodyMode === "text" ||
		request.bodyMode === "jsonrpc" ||
		request.bodyMode === "mcp" ||
		request.bodyMode === "xml";
	const isTable =
		request.bodyMode === "form-data" || request.bodyMode === "x-www-form-urlencoded";
	const tableItems = request.bodyMode === "form-data" ? request.formData : request.urlEncoded;
	// Stable, as HeadersPanel's handler: it is `KeyValueEditor`'s `onChange`, whose identity gates
	// every row's memo (#1716). It changes only with the body mode.
	const onTableChange = useCallback(
		(items: KeyValueItem[]) =>
			updateField(request.bodyMode === "form-data" ? "formData" : "urlEncoded", items),
		[updateField, request.bodyMode]
	);

	// Memoised on the scope alone: `rowExtra` is a prop of the memo'd rows (#1716).
	const contentTypeRowExtra = useMemo(() => contentTypeExtra(variables), [variables]);

	return (
		/*
		 * A column filling the tab panel: the picker, notice and Source/Resolved swap keep their
		 * height, the editor takes the rest. `min-h-0` lets it take *less* than its content; a flex
		 * child refuses to shrink below content without it, the two-scrollbars bug in
		 * `docs/design-system/overflow-and-shrink.md`.
		 */
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<div className="flex items-center justify-between gap-3">
				<div className="flex items-center gap-2 min-w-0">
					<Select value={request.bodyMode} onValueChange={handleModeChange}>
						<SelectTrigger className="h-control-sm w-auto" aria-label="Body type">
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

					{/* What goes on the wire, beside the picker. */}
					{wireContentType ? (
						<code className="truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-label text-muted-foreground">
							{wireContentType}
						</code>
					) : request.bodyMode === "binary" ? (
						<span className="text-xs text-muted-foreground">
							Type from the file extension
						</span>
					) : (
						<span className="text-xs text-muted-foreground">No body will be sent.</span>
					)}
				</div>

				{/* Source / Resolved, as a swap; only when the body contains a variable. */}
				{hasVariables && isCodeMode && (
					<div className="flex shrink-0 items-center gap-1">
						<Button
							size="sm"
							variant={showResolved ? "ghost" : "secondary"}
							onClick={() => setShowResolved(false)}
							className="h-control-sm px-2.5 text-xs"
						>
							Source
						</Button>
						<Button
							size="sm"
							variant={showResolved ? "secondary" : "ghost"}
							onClick={() => setShowResolved(true)}
							className="h-control-sm px-2.5 text-xs"
						>
							Resolved
						</Button>
					</div>
				)}
			</div>

			{/*
			 * `/10` and `/30`, the accent tint of the Load Test button and the variable popover.
			 */}
			{addedContentType && (
				<ContentTypeNotice
					value={addedContentType}
					onUndo={undoContentType}
					onDismiss={() => setAddedContentType(null)}
				/>
			)}

			{isCodeMode && showResolved && resolvedBody.refusals.length > 0 && (
				<Callout severity="warning" title="Sending with this row is refused">
					{refusalsText(resolvedBody.refusals)}
				</Callout>
			)}

			{request.bodyMode === "mcp" && (
				<McpToolFields
					key={memoryKey}
					tool={request.mcpTool}
					onToolChange={(tool) => updateField("mcpTool", tool)}
					requestId={request.id ?? null}
				/>
			)}

			{isCodeMode && (
				<div className={EDITOR_BOX}>
					{showResolved ? (
						<pre className="h-full overflow-auto whitespace-pre-wrap bg-muted/50 p-3 font-mono text-sm">
							{shownResolvedBody || (
								<span className="italic text-muted-foreground">Empty body</span>
							)}
						</pre>
					) : (
						<CodeEditor
							height="100%"
							language={
								request.bodyMode === "json" ||
								request.bodyMode === "jsonrpc" ||
								request.bodyMode === "mcp"
									? "json"
									: request.bodyMode === "xml"
										? "xml"
										: "plaintext"
							}
							ariaLabel="Request body"
							path={requestModelPath(request.id, "body")}
							value={request.body || ""}
							onChange={(v) => updateField("body", v ?? "")}
							onMount={mountBodyDiagnostics}
						/>
					)}
				</div>
			)}

			{isCodeMode && showResolved && deferredInBody.length > 0 && (
				<p className="text-label text-muted-foreground m-0 break-words">
					{deferredNote(deferredInBody)}
				</p>
			)}

			{request.bodyMode === "graphql" && (
				<div className={EDITOR_BOX}>
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
							method={request.method}
							onBodyChange={(b) => updateField("body", b)}
							requestId={request.id ?? null}
							schemaTarget={gqlSchemaTarget}
							variablesDraft={ownVariablesDraft(
								getVariablesDraft(),
								request.id ?? null
							)}
							onVariablesDraftChange={handleVariablesDraftChange}
						/>
					</Suspense>
				</div>
			)}

			{request.bodyMode === "binary" && <BinaryBodyPanel />}

			{isTable && (
				<KeyValueEditor
					items={tableItems.length > 0 ? tableItems : [createEmptyKeyValue()]}
					onChange={onTableChange}
					keyPlaceholder="Key"
					valuePlaceholder="Value"
					showResolved={true}
					allowDisable={true}
					// Only multipart carries a file: urlencoded is a string of pairs, and the
					// engine refuses a file part there.
					allowFiles={request.bodyMode === "form-data"}
					// A part's own Content-Type is multipart-only, like a file part (#3022).
					rowExtra={request.bodyMode === "form-data" ? contentTypeRowExtra : undefined}
					variables={variables}
				/>
			)}
		</div>
	);
}
