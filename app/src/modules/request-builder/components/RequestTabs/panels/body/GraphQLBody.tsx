/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The GraphQL body: a query pane over a variables pane, with the schema
 * lifecycle that makes both of them smart.
 *
 * This was roughly 40% of `BodyPanel`, and the only mode with an editor *pair*,
 * an introspection lifecycle and a header side effect of its own. Everything
 * here is GraphQL-specific; nothing here is shared with the JSON, text or
 * key/value modes, which is why it now lives on its own.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, AlertCircle, Loader2, RefreshCw } from "lucide-react";
import type { OnMount } from "@monaco-editor/react";
import {
	CodeEditor,
	EYEBROW_CLASS,
	ResizablePanelGroup,
	ResizablePanel,
	ResizableHandle,
	Tooltip,
	TooltipTrigger,
	TooltipContent,
} from "@/components/ui";
import { useSchemaCache } from "@/lib/graphql/schema-cache";
import { applyVariablesSchema } from "@/lib/graphql/variables-schema";
import { cn } from "@/lib/utils";
import { TIMING } from "@/config/timing";
import { parseGraphQLBody, serializeGraphQLBody } from "./graphql-body";

export interface GraphQLBodyProps {
	body: string;
	onBodyChange: (body: string) => void;
	/** The request URL with `{{variables}}` already resolved. */
	resolvedUrl: string;
	/** Headers with `{{variables}}` already resolved, for introspection. */
	resolvedHeaders: () => Record<string, string>;
	/** Registers each editor so the panel can relayout them on a height change. */
	onEditorMount: OnMount;
	/** True while the mode is graphql - drives the schema lifecycle. */
	active: boolean;
}

function SchemaStatusBadge({ status }: { status: "idle" | "loading" | "ready" | "error" }) {
	if (status === "idle") return null;
	if (status === "loading") {
		return (
			<span className="flex items-center gap-1 text-[10px] text-muted-foreground">
				<Loader2 className="w-3 h-3 animate-spin" />
				Schema
			</span>
		);
	}
	if (status === "ready") {
		return (
			<span className="flex items-center gap-1 text-[10px] text-success-text">
				<CheckCircle2 className="w-3 h-3" />
				Schema
			</span>
		);
	}
	return (
		<span
			className="flex items-center gap-1 text-[10px] text-destructive-text"
			title="Schema introspection failed - syntax checking only"
		>
			<AlertCircle className="w-3 h-3" />
			No schema
		</span>
	);
}

function PaneHeader({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex items-center justify-between px-3 py-1 border-b border-border bg-panel shrink-0">
			{children}
		</div>
	);
}

function PaneTitle({ children }: { children: string }) {
	// `EYEBROW_CLASS` rather than the `Eyebrow` component: this sits in a
	// `flex items-center justify-between` bar beside a control, where the
	// primitive's `<p>` would be the wrong element for an inline label.
	return <span className={EYEBROW_CLASS}>{children}</span>;
}

export function GraphQLBody({
	body,
	onBodyChange,
	resolvedUrl,
	resolvedHeaders,
	onEditorMount,
	active,
}: GraphQLBodyProps) {
	const schemaStatus = useSchemaCache((s) => s.getActiveStatus());
	const activeSchema = useSchemaCache((s) => s.getActiveSchema());

	const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
	const [variablesModelUri, setVariablesModelUri] = useState<string | null>(null);
	const handleVariablesMount: OnMount = (editorInstance, monacoInstance) => {
		onEditorMount(editorInstance, monacoInstance);
		monacoRef.current = monacoInstance;
		setVariablesModelUri(editorInstance.getModel()?.uri.toString() ?? null);
	};

	// Track the resolved endpoint as the active schema URL and (debounced)
	// introspect it, so the editors' language providers can validate and
	// autocomplete against the real schema.
	useEffect(() => {
		if (!active) {
			useSchemaCache.getState().setActiveUrl(null);
			return;
		}
		useSchemaCache.getState().setActiveUrl(resolvedUrl || null);
		if (!resolvedUrl) return;
		const headers = resolvedHeaders();
		const id = setTimeout(() => {
			void useSchemaCache.getState().ensureSchema(resolvedUrl, headers);
		}, TIMING.GRAPHQL_INTROSPECTION_DEBOUNCE_MS);
		return () => clearTimeout(id);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active, resolvedUrl]);

	// The query is always a valid string, so derive it from the body directly.
	const query = useMemo(() => parseGraphQLBody(body || "").query, [body]);

	/*
	 * The variables editor keeps its own raw text as the source of truth: while
	 * the user types an object, intermediate states are invalid JSON which
	 * `serializeGraphQLBody` drops - so re-deriving the editor value from the
	 * body would wipe their input. Re-sync from the body only on external
	 * changes (request switch, mode switch), tracked via the body we last wrote.
	 */
	const [variables, setVariables] = useState("");
	const lastWrittenBody = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (!active) return;
		if (body === lastWrittenBody.current) return;
		setVariables(parseGraphQLBody(body || "").variables);
		lastWrittenBody.current = body;
	}, [active, body]);

	const write = (nextQuery: string, nextVariables: string) => {
		const next = serializeGraphQLBody(nextQuery, nextVariables);
		lastWrittenBody.current = next;
		onBodyChange(next);
	};

	// Drive the variables editor's JSON schema from the query's `$variables` plus
	// the introspected schema, so it validates and autocompletes against what the
	// operation expects. Clears the schema when this mode is not active.
	useEffect(() => {
		const monaco = monacoRef.current;
		if (!monaco || !variablesModelUri) return;
		applyVariablesSchema(
			monaco,
			variablesModelUri,
			active ? query : "",
			active ? activeSchema : null
		);
	}, [active, query, activeSchema, variablesModelUri]);

	const refresh = () => {
		if (!resolvedUrl) return;
		void useSchemaCache.getState().refreshSchema(resolvedUrl, resolvedHeaders());
	};

	return (
		<ResizablePanelGroup orientation="vertical" className="h-full">
			<ResizablePanel defaultSize="65%" minSize="25%" className="flex flex-col">
				<PaneHeader>
					<PaneTitle>Query</PaneTitle>
					<div className="flex items-center gap-2">
						<SchemaStatusBadge status={schemaStatus} />
						{resolvedUrl && (
							/*
							 * Bespoke tiny affordance (12px, no button chrome), so it wraps
							 * Tooltip by hand rather than using TooltipIconButton, whose
							 * icon-size Button would dwarf it here. Same result: a real
							 * tooltip plus a name, replacing the old title.
							 */
							<Tooltip>
								<TooltipTrigger asChild>
									<button
										type="button"
										onClick={refresh}
										disabled={schemaStatus === "loading"}
										aria-label="Refresh schema"
										className="text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
									>
										<RefreshCw
											className={cn(
												"w-3 h-3",
												schemaStatus === "loading" && "animate-spin"
											)}
										/>
									</button>
								</TooltipTrigger>
								<TooltipContent side="top">Refresh schema</TooltipContent>
							</Tooltip>
						)}
					</div>
				</PaneHeader>
				{/*
				 * min-h-0: a flex item will not shrink below its content, so without
				 * it the editor keeps its old height when the pane is dragged smaller.
				 * The panel then overflows and grows a native scrollbar beside the
				 * editor's own - two scrollbars for one editor. Same trap as min-w-0
				 * on truncating rows.
				 */}
				<div className="min-h-0 flex-1">
					<CodeEditor
						height="100%"
						language="graphql"
						value={query}
						onChange={(q) => write(q ?? "", variables)}
						onMount={onEditorMount}
					/>
				</div>
			</ResizablePanel>

			{/*
			 * A hairline, and no grip. This splits one editor from another *inside*
			 * the box; the handle below the box resizes the whole thing and carries
			 * the grip. They used to be identical - two 6px grey bars doing different
			 * jobs with nothing to tell them apart.
			 */}
			<ResizableHandle className="h-px w-full cursor-row-resize bg-rule hover:bg-primary transition-colors" />

			<ResizablePanel defaultSize="35%" minSize="15%" className="flex flex-col">
				<PaneHeader>
					<PaneTitle>Variables</PaneTitle>
				</PaneHeader>
				<div className="min-h-0 flex-1">
					<CodeEditor
						height="100%"
						language="json"
						value={variables}
						onChange={(v) => {
							setVariables(v ?? "");
							write(query, v ?? "");
						}}
						onMount={handleVariablesMount}
					/>
				</div>
			</ResizablePanel>
		</ResizablePanelGroup>
	);
}

export default GraphQLBody;
