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
import {
	schemaCacheKey,
	useSchemaCache,
	type SchemaEntry,
	type SchemaFailure,
	type SchemaTarget,
} from "@/lib/graphql/schema-cache";
import { applyVariablesSchema } from "@/lib/graphql/variables-schema";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/utils/helpers";
import { TIMING } from "@/config/timing";
import { parseGraphQLBody, serializeGraphQLBody } from "./graphql-body";

export interface GraphQLBodyProps {
	body: string;
	onBodyChange: (body: string) => void;
	/**
	 * The endpoint to introspect: the request as typed plus its scope, which
	 * the engine composes (`POST /compose`) before the introspection query is
	 * sent. Unresolved on purpose - only `resolvedUrl` and `resolvedAuth` inside
	 * it are previews, used for cache identity and display, never sent.
	 */
	schemaTarget: SchemaTarget;
	/** Registers each editor so the panel can relayout them on a height change. */
	onEditorMount: OnMount;
}

/**
 * What the badge says about a failure, per kind.
 *
 * The store keeps the classified failure and the engine's own words; this is
 * the sentence that names the fix. One static "introspection failed" used to
 * cover all of them, so an expired token and an endpoint with introspection
 * switched off - opposite actions - read identically (#383).
 *
 * Exhaustive by type: a new failure kind in `introspect.ts` is a type error
 * here rather than a silent fall back to the generic sentence.
 */
const FAILURE_HINT: Record<SchemaFailure["kind"], string> = {
	auth: "Credentials were rejected. Check the request's auth, then refresh.",
	unsupported: "This endpoint does not allow introspection, so only syntax is checked.",
	http: "The endpoint answered with an error status.",
	network: "The endpoint could not be reached.",
	parse: "The answer was not an introspection result.",
	"too-large": "The schema is too large to load.",
	unknown: "Introspection failed.",
};

function SchemaStatusBadge({ entry }: { entry: SchemaEntry | null }) {
	const status = entry?.status ?? "idle";
	if (status === "idle") return null;

	const age = entry?.fetchedAt ? `Schema loaded ${formatRelativeTime(entry.fetchedAt)}.` : null;

	if (status === "loading") {
		return (
			<BadgeText className="text-muted-foreground" title={age ?? "Loading the schema."}>
				<Loader2 className="w-3 h-3 animate-spin" />
				Schema
			</BadgeText>
		);
	}

	if (status === "ready") {
		return (
			<BadgeText className="text-success-text" title={age ?? "Schema loaded."}>
				<CheckCircle2 className="w-3 h-3" />
				Schema
			</BadgeText>
		);
	}

	const failure = entry?.error;
	const hint = FAILURE_HINT[failure?.kind ?? "unknown"];
	const detail = failure?.message ? `${hint} ${failure.message}` : hint;

	/*
	 * A refresh that failed over a schema that loaded earlier is not "no schema":
	 * the editors still complete against the last good one, so the badge says
	 * how old it is and what went wrong, rather than claiming there is nothing.
	 */
	if (entry?.schema) {
		return (
			<BadgeText className="text-warning-text" title={age ? `${detail} ${age}` : detail}>
				<AlertCircle className="w-3 h-3" />
				Schema stale
			</BadgeText>
		);
	}

	return (
		<BadgeText className="text-destructive-text" title={`${detail} Syntax checking only.`}>
			<AlertCircle className="w-3 h-3" />
			No schema
		</BadgeText>
	);
}

function BadgeText({
	className,
	title,
	children,
}: {
	className: string;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<span className={cn("flex items-center gap-1 text-[10px]", className)} title={title}>
			{children}
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

export function GraphQLBody({ body, onBodyChange, schemaTarget, onEditorMount }: GraphQLBodyProps) {
	// One subscription, not three: the entry object is the store's own reference,
	// so it is a stable snapshot, and status/schema/error/freshness cannot be
	// read a render apart from each other.
	const entry = useSchemaCache((s) => s.getActiveEntry());
	const schemaStatus = entry?.status ?? "idle";
	const activeSchema = entry?.schema ?? null;

	const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
	const [variablesModelUri, setVariablesModelUri] = useState<string | null>(null);
	const handleVariablesMount: OnMount = (editorInstance, monacoInstance) => {
		onEditorMount(editorInstance, monacoInstance);
		monacoRef.current = monacoInstance;
		setVariablesModelUri(editorInstance.getModel()?.uri.toString() ?? null);
	};

	/*
	 * Track the endpoint as the active schema target and (debounced) introspect
	 * it, so the editors' language providers can validate and autocomplete
	 * against the real schema.
	 *
	 * Keyed on the cache key rather than the URL: the credentials are part of
	 * the target now, so changing environment - or the auth block, or a variable
	 * either resolves through - is a different schema to fetch, not the same one
	 * already cached.
	 *
	 * The cleanup clears the target as well as the debounce. This component
	 * mounts only while the body mode is graphql, so unmounting *is* leaving
	 * GraphQL, and leaving the last one pointing at a schema kept Monaco
	 * completing a closed tab's endpoint. The clear is guarded on still being
	 * the active target, so switching requests - which mounts the next body
	 * before this one's cleanup runs - does not blank the new one.
	 */
	const targetKey = schemaCacheKey(schemaTarget);
	useEffect(() => {
		useSchemaCache.getState().setActiveTarget(schemaTarget);
		if (!schemaTarget.url)
			return () => useSchemaCache.getState().clearActiveTarget(schemaTarget);
		const id = setTimeout(() => {
			void useSchemaCache.getState().ensureSchema(schemaTarget);
		}, TIMING.GRAPHQL_INTROSPECTION_DEBOUNCE_MS);
		return () => {
			clearTimeout(id);
			useSchemaCache.getState().clearActiveTarget(schemaTarget);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [targetKey]);

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
		if (body === lastWrittenBody.current) return;
		setVariables(parseGraphQLBody(body || "").variables);
		lastWrittenBody.current = body;
	}, [body]);

	const write = (nextQuery: string, nextVariables: string) => {
		const next = serializeGraphQLBody(nextQuery, nextVariables);
		lastWrittenBody.current = next;
		onBodyChange(next);
	};

	// Drive the variables editor's JSON schema from the query's `$variables` plus
	// the introspected schema, so it validates and autocompletes against what the
	// operation expects.
	useEffect(() => {
		const monaco = monacoRef.current;
		if (!monaco || !variablesModelUri) return;
		applyVariablesSchema(monaco, variablesModelUri, query, activeSchema);
	}, [query, activeSchema, variablesModelUri]);

	const refresh = () => {
		if (!schemaTarget.url) return;
		void useSchemaCache.getState().refreshSchema(schemaTarget);
	};

	return (
		<ResizablePanelGroup orientation="vertical" className="h-full">
			<ResizablePanel defaultSize="65%" minSize="25%" className="flex flex-col">
				<PaneHeader>
					<PaneTitle>Query</PaneTitle>
					<div className="flex items-center gap-2">
						<SchemaStatusBadge entry={entry} />
						{schemaTarget.url && (
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
