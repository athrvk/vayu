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
import {
	CheckCircle2,
	AlertCircle,
	Braces,
	Loader2,
	PanelRightClose,
	PanelRightOpen,
	RefreshCw,
} from "lucide-react";
import type { OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import {
	CodeEditor,
	EYEBROW_CLASS,
	ResizablePanelGroup,
	ResizablePanel,
	ResizableHandle,
	Tooltip,
	TooltipTrigger,
	TooltipContent,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui";
import {
	schemaCacheKey,
	useSchemaCache,
	type SchemaEntry,
	type SchemaFailure,
	type SchemaTarget,
} from "@/lib/graphql/schema-cache";
import { applyVariablesSchema } from "@/lib/graphql/variables-schema";
import { useExplorerStore } from "@/lib/graphql/explorer-store";
import {
	insertionForNode,
	isRefusal,
	mergeVariables,
	type DocumentInsertion,
} from "@/lib/graphql/insert-skeleton";
import type { SchemaTreeNode } from "@/lib/graphql/schema-tree";
import { SchemaExplorer } from "./graphql-explorer/SchemaExplorer";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/utils/helpers";
import { TIMING } from "@/config/timing";
import {
	classifyVariables,
	operationNames,
	parseGraphQLBody,
	serializeGraphQLBody,
	type GraphQLBodyParts,
	type VariablesForm,
} from "@/lib/graphql/graphql-body";

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
	/**
	 * The Variables pane's text as this request last had it, or null for none.
	 *
	 * Seeds the pane instead of the body, because the body cannot hold text that
	 * is neither JSON nor a template. It comes from the provider rather than from
	 * here so that it outlives this component, which Radix unmounts on every
	 * glance at another tab (`utils/body-drafts.ts`).
	 */
	variablesDraft: string | null;
	onVariablesDraftChange: (text: string) => void;
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

/**
 * What the Variables pane's text will do when the request is sent.
 *
 * Nothing at all for `empty` and `json`, which is the common case and needs no
 * chrome. The other two are the point: to Monaco's JSON worker a `{{token}}` and
 * an unclosed brace are the same red squiggle, and on the wire they could not be
 * more different - one is resolved and sent, the other is not sent at all. The
 * silent drop is what #384 item 5 reports; naming it is the fix, because the
 * request otherwise goes out with no variables and nothing on screen says so.
 */
function VariablesFormBadge({ form }: { form: VariablesForm }) {
	if (form === "empty" || form === "json") return null;

	if (form === "templated") {
		return (
			<BadgeText
				className="text-muted-foreground"
				title="These variables contain {{variables}}, so they are not JSON until the request is sent. They are resolved and sent."
			>
				<Braces className="w-3 h-3" />
				Templated
			</BadgeText>
		);
	}

	return (
		<BadgeText
			className="text-warning-text"
			title="These variables are not valid JSON, so the request will be sent without them."
		>
			<AlertCircle className="w-3 h-3" />
			Not sent
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

/** Where an insertion landed, in words a screen reader can use. */
const PLACEMENT_PHRASE: Record<DocumentInsertion["placement"], string> = {
	cursor: "at the cursor",
	ancestor: "into the enclosing selection",
	"new-operation": "as a new operation",
	fragment: "as a new fragment",
};

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
	schemaTarget,
	onEditorMount,
	variablesDraft,
	onVariablesDraftChange,
}: GraphQLBodyProps) {
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

	const explorerOpen = useExplorerStore((s) => s.open);
	const setExplorerOpen = useExplorerStore((s) => s.setOpen);
	const queryEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
	const handleQueryMount: OnMount = (editorInstance, monacoInstance) => {
		onEditorMount(editorInstance, monacoInstance);
		queryEditorRef.current = editorInstance;
	};

	/*
	 * The explorer's two outputs that are not the document itself: what to say,
	 * and which variables the pane could not be given a value for.
	 *
	 * The announcement is keyed as well as stored, because a live region is only
	 * announced when its text *changes* - inserting the same field twice would
	 * otherwise be silent the second time, which reads as the click not landing.
	 * Same fix, same reason, as `ResponseAnnouncer`.
	 */
	const [announcement, setAnnouncement] = useState("");
	const [announcementSeq, setAnnouncementSeq] = useState(0);
	const [pendingVariables, setPendingVariables] = useState<string[]>([]);
	const announce = (message: string) => {
		setAnnouncement(message);
		setAnnouncementSeq((n) => n + 1);
	};

	/*
	 * Where to put the caret once the new document has reached the editor.
	 *
	 * Deferred to an effect rather than set inline: the query pane is controlled
	 * by its `value` prop, so at the moment of the insertion Monaco's model still
	 * holds the old text and an offset into the new one would land anywhere.
	 * `CodeEditor` is a child, and a child's effects run before this one, so by
	 * the time the effect fires the model holds the text the offset was computed
	 * against.
	 *
	 * A ref rather than state: nothing renders from it, and clearing it as state
	 * inside the effect that consumes it is a second render per insertion for a
	 * value nobody draws (`react-hooks/set-state-in-effect` flags exactly that).
	 */
	const pendingCursor = useRef<number | null>(null);

	// No endpoint means no schema to browse, and the toggle that opens this is
	// hidden for the same reason - the pane would only ever say "no schema".
	const showExplorer = explorerOpen && !!schemaTarget.url;

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

	/*
	 * Everything the envelope carries, derived from the body. The query and
	 * `operationName` are always valid strings, and `extras` holds whatever else
	 * the envelope had - all three ride along on every write, which is what stops
	 * a keystroke in either pane from deleting them.
	 */
	const parts = useMemo(() => parseGraphQLBody(body || ""), [body]);
	const query = parts.query;

	/*
	 * The variables editor keeps its own raw text as the source of truth: while
	 * the user types an object, intermediate states are invalid JSON which
	 * `serializeGraphQLBody` drops - so re-deriving the editor value from the
	 * body would wipe their input. Re-sync from the body only on external
	 * changes (request switch, mode switch), tracked via the body we last wrote.
	 *
	 * The draft is what makes that survive an unmount: the state below is gone
	 * the moment Radix tears the tab down, and seeding it from the body alone
	 * would then lose exactly the text the body could not carry.
	 */
	const [variables, setVariables] = useState(
		() => variablesDraft ?? parseGraphQLBody(body || "").variables
	);
	// Seeded with the mounted body so the effect below does not immediately
	// re-derive the pane from it and discard the draft just restored.
	const lastWrittenBody = useRef<string | undefined>(body);
	useEffect(() => {
		if (body === lastWrittenBody.current) return;
		const next = parseGraphQLBody(body || "").variables;
		setVariables(next);
		onVariablesDraftChange(next);
		lastWrittenBody.current = body;
	}, [body, onVariablesDraftChange]);

	/*
	 * One write path, taking only what changed. The rest comes from `parts` (the
	 * envelope as last stored) and from `variables` (the pane's own draft, which
	 * is ahead of the body while it is mid-edit) - so a caller cannot write a
	 * field by naming it and drop another by not naming it.
	 */
	const write = (changed: Partial<GraphQLBodyParts>) => {
		const next = serializeGraphQLBody({ ...parts, variables, ...changed });
		lastWrittenBody.current = next;
		onBodyChange(next);
	};

	/*
	 * A document with two operations must say which one to run - the spec forbids
	 * an anonymous operation beside a named one, and a server given no
	 * `operationName` for such a document answers with an error, not a guess. So
	 * the picker appears exactly when the choice becomes real.
	 *
	 * An `operationName` the document no longer defines (renamed, or the pane is
	 * mid-edit) is still what will be sent, so it is offered as an option rather
	 * than dropped: the trigger then shows the truth, and picking a real
	 * operation is one click. Nothing here rewrites the body on its own.
	 */
	const names = useMemo(() => operationNames(query), [query]);
	const operations =
		parts.operationName && !names.includes(parts.operationName)
			? [...names, parts.operationName]
			: names;

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

	useEffect(() => {
		const offset = pendingCursor.current;
		if (offset === null) return;
		pendingCursor.current = null;
		const instance = queryEditorRef.current;
		const model = instance?.getModel();
		if (!instance || !model) return;
		const position = model.getPositionAt(offset);
		instance.setPosition(position);
		instance.revealPositionInCenterIfOutsideViewport(position);
		instance.focus();
	}, [query]);

	/**
	 * Insert what the explorer row stands for, and say what happened.
	 *
	 * The query and the variables are written in **one** `serializeGraphQLBody`
	 * call rather than two. Two writes would each re-serialise from `parts`,
	 * and the second - built from this render's closure - would carry the
	 * pre-merge variables and undo the first.
	 */
	const handleExplorerInsert = (node: SchemaTreeNode) => {
		if (!activeSchema) return;
		const model = queryEditorRef.current?.getModel();
		const position = queryEditorRef.current?.getPosition();
		const cursor = model && position ? model.getOffsetAt(position) : query.length;

		const result = insertionForNode(activeSchema, node, query, cursor);
		if (!result) return;
		if (isRefusal(result)) {
			announce(result.reason);
			return;
		}

		const merged = mergeVariables(variables, result.variables);
		setVariables(merged.text);
		onVariablesDraftChange(merged.text);
		setPendingVariables(merged.pending);

		const next = serializeGraphQLBody({
			...parts,
			query: result.text,
			variables: merged.text,
		});
		lastWrittenBody.current = next;
		onBodyChange(next);
		pendingCursor.current = result.cursor;

		const unwritten = merged.pending.length
			? ` ${merged.pending.length} ${merged.pending.length === 1 ? "variable needs" : "variables need"} a value: ${merged.pending.join(", ")}.`
			: "";
		announce(`Inserted ${result.label} ${PLACEMENT_PHRASE[result.placement]}.${unwritten}`);
	};

	const editors = (
		<ResizablePanelGroup orientation="vertical" className="h-full">
			<ResizablePanel defaultSize="65%" minSize="25%" className="flex flex-col">
				<PaneHeader>
					<PaneTitle>Query</PaneTitle>
					<div className="flex items-center gap-2">
						{names.length > 1 && (
							<Select
								value={parts.operationName}
								onValueChange={(name) => write({ operationName: name })}
							>
								<SelectTrigger
									className="h-6 w-auto gap-1 px-2 text-[11px]"
									aria-label="Operation"
								>
									<SelectValue placeholder="Operation" />
								</SelectTrigger>
								<SelectContent>
									{operations.map((name) => (
										<SelectItem key={name} value={name}>
											{name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
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
						{/*
						 * The explorer toggle sits beside the schema badge because it
						 * is the same subject: the badge says whether there is a
						 * schema, this opens it. Same 12px affordance as Refresh.
						 */}
						{schemaTarget.url && (
							<Tooltip>
								<TooltipTrigger asChild>
									<button
										type="button"
										onClick={() => setExplorerOpen(!explorerOpen)}
										aria-label={explorerOpen ? "Hide schema" : "Browse schema"}
										aria-pressed={explorerOpen}
										className="text-muted-foreground hover:text-foreground transition-colors"
									>
										{explorerOpen ? (
											<PanelRightClose className="w-3 h-3" />
										) : (
											<PanelRightOpen className="w-3 h-3" />
										)}
									</button>
								</TooltipTrigger>
								<TooltipContent side="top">
									{explorerOpen ? "Hide schema" : "Browse schema"}
								</TooltipContent>
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
						onChange={(q) => write({ query: q ?? "" })}
						onMount={handleQueryMount}
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
					<div className="flex items-center gap-2">
						<PendingVariablesBadge names={pendingVariables} />
						<VariablesFormBadge form={classifyVariables(variables)} />
					</div>
				</PaneHeader>
				<div className="min-h-0 flex-1">
					<CodeEditor
						height="100%"
						language="json"
						value={variables}
						onChange={(v) => {
							setVariables(v ?? "");
							onVariablesDraftChange(v ?? "");
							write({ variables: v ?? "" });
							/*
							 * The badge names variables the pane refused to be given.
							 * Once the user has touched the pane it is their text, and
							 * a stale list of names they may have just typed in is
							 * worse than none.
							 */
							setPendingVariables([]);
						}}
						onMount={handleVariablesMount}
					/>
				</div>
			</ResizablePanel>
		</ResizablePanelGroup>
	);

	return (
		/*
		 * One horizontal group, always. Rendering the group only while the
		 * explorer is open would move the editors to a different position in the
		 * tree on every toggle, and remounting Monaco throws away the undo stack
		 * and the scroll position - a heavy price for a pane that opens and
		 * closes. Keys hold the editors' identity across the conditional
		 * siblings.
		 */
		<ResizablePanelGroup orientation="horizontal" className="h-full">
			{showExplorer && (
				<ResizablePanel
					key="explorer"
					defaultSize="34%"
					minSize="18%"
					className="flex flex-col min-w-0"
				>
					<SchemaExplorer
						schema={activeSchema}
						status={schemaStatus}
						fetchedAt={entry?.fetchedAt ?? null}
						schemaKey={targetKey}
						onRefresh={refresh}
						onInsert={handleExplorerInsert}
					/>
				</ResizablePanel>
			)}
			{showExplorer && (
				<ResizableHandle
					key="explorer-handle"
					className="w-px h-full cursor-col-resize bg-rule hover:bg-primary transition-colors"
				/>
			)}
			<ResizablePanel
				key="editors"
				defaultSize={showExplorer ? "66%" : "100%"}
				minSize="30%"
				className="flex flex-col min-w-0"
			>
				{editors}
			</ResizablePanel>

			{/*
			 * The live region is mounted whether or not it has anything to say -
			 * a region added to the DOM alongside its first message is not
			 * announced, which is the trap `ResponseAnnouncer` and the Toaster
			 * both record.
			 */}
			<div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
				<span key={announcementSeq}>{announcement}</span>
			</div>
		</ResizablePanelGroup>
	);
}

/**
 * Variables an insertion declared but could not write, because the pane held
 * text that was not strict JSON.
 *
 * The alternative was to overwrite the pane, which would delete a working
 * `{{token}}` draft to make room for a placeholder. Naming them is what stops
 * that being a silent gap between the query and the values it needs.
 */
function PendingVariablesBadge({ names }: { names: string[] }) {
	if (names.length === 0) return null;
	return (
		<BadgeText
			className="text-warning-text"
			title={`The Variables pane is not plain JSON, so these were not added: ${names.join(", ")}.`}
		>
			<AlertCircle className="w-3 h-3" />
			{`${names.length} ${names.length === 1 ? "variable needs" : "variables need"} a value`}
		</BadgeText>
	);
}

export default GraphQLBody;
