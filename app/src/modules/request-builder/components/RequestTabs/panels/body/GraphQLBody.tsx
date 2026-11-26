/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The GraphQL body: a query pane over a variables pane, with the schema lifecycle that makes both
 * smart. The only mode with an editor *pair*, an introspection lifecycle and a header side effect
 * of its own, and nothing here is shared with the JSON, text or key/value modes, hence its own
 * file.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	AlertCircle,
	Braces,
	ChevronDown,
	ChevronRight,
	Loader2,
	PanelLeftClose,
	PanelLeftOpen,
	RefreshCw,
} from "lucide-react";
import type { OnMount } from "@monaco-editor/react";
import type { HttpMethod } from "@/types";
import type { PanelImperativeHandle } from "react-resizable-panels";
import type { editor } from "monaco-editor";
import {
	CodeEditor,
	EYEBROW_CLASS,
	ResizablePanelGroup,
	ResizablePanel,
	ResizableHandle,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	TooltipIconButton,
} from "@/components/ui";
import {
	schemaCacheKey,
	useSchemaCache,
	type SchemaEntry,
	type SchemaTarget,
} from "@/lib/graphql/schema-cache";
import { applyVariablesSchema } from "@/lib/graphql/variables-schema";
import { attachVariablesDiagnostics } from "@/lib/graphql/variables-diagnostics";
import { useExplorerStore } from "@/lib/graphql/explorer-store";
import {
	insertionForNode,
	isAlreadyPresent,
	isRefusal,
	mergeVariables,
	type DocumentInsertion,
} from "@/lib/graphql/insert-skeleton";
import type { SchemaTreeNode } from "@/lib/graphql/schema-tree";
import { CopyForAgentButton } from "@/components/shared/CopyForAgentButton";
import { SchemaExplorer } from "./graphql-explorer/SchemaExplorer";
import { BadgeText, SchemaStatusBadge } from "./SchemaStatusBadge";
import { sendsGraphQLInTheUrl } from "./graphql-method";
import { useClientSettingsStore, useLayoutStore } from "@/stores";
import {
	GRAPHQL_PANE_HEADER_HEIGHT,
	GRAPHQL_VARIABLES_MAX_SIZE,
	GRAPHQL_VARIABLES_MIN_SIZE,
} from "@/constants/layout";
import { cn } from "@/lib/utils";
import { TIMING } from "@/config/timing";
import {
	classifyVariables,
	findOperationLine,
	operationNames,
	parseGraphQLBody,
	serializeGraphQLBody,
	type GraphQLBodyParts,
	type VariablesForm,
} from "@/lib/graphql/graphql-body";
import { useRevealStore, type OperationRevealCommand } from "@/lib/graphql/reveal-store";
import { pluralize } from "@/modules/dashboard/utils/format";
import { requestModelPath } from "../../../../utils/editor-models";

export interface GraphQLBodyProps {
	body: string;
	onBodyChange: (body: string) => void;
	/**
	 * Whose body this is: tells a reveal command for this request from another's, as the body
	 * drafts do (`utils/body-drafts.ts`), and files each pane's Monaco model and undo stack under
	 * this request (`utils/editor-models.ts`).
	 */
	requestId: string | null;
	/**
	 * The endpoint to introspect: the request as typed plus its scope, composed by the engine
	 * (`POST /compose`) before introspection. Unresolved on purpose; only `resolvedUrl` and
	 * `resolvedAuth` in it are previews, for cache identity and display, never sent.
	 */
	schemaTarget: SchemaTarget;
	/**
	 * The Variables pane's last text for this request, or null. Seeds the pane instead of the body,
	 * which cannot hold text that is neither JSON nor a template; from the provider so it outlives
	 * this component, which Radix unmounts on every glance elsewhere (`utils/body-drafts.ts`).
	 */
	variablesDraft: string | null;
	onVariablesDraftChange: (text: string) => void;
	/**
	 * The send method, read for one thing: GraphQL over `GET` is another transport (the document
	 * goes as query parameters, a mutation cannot be sent), and the Query header says so then
	 * (#1228).
	 */
	method: HttpMethod;
	/**
	 * The agent reference line for an operation (`graphqlOperationReference`), undefined while the
	 * request is unsaved or its row loading: the line names the request by id. A prop, not a query,
	 * so this lazy body stays free of the data layer.
	 */
	operationReference?: (operationName: string) => string;
}

/**
 * What the Variables text will do on send. Nothing for `empty` and `json`, the common case. The
 * other two are the point: to Monaco's JSON worker a `{{token}}` and an unclosed brace are the same
 * squiggle, but one is resolved and sent, the other not sent at all. Naming the silent drop (#384
 * item 5) is the fix, as the request otherwise goes without variables and nothing says so.
 */
function VariablesFormBadge({ form }: { form: VariablesForm }) {
	if (form === "empty" || form === "json") return null;

	if (form === "templated") {
		return (
			<BadgeText
				className="text-muted-foreground"
				title="These variables contain {{variables}}, so they are not JSON until the request is sent. They are resolved and sent."
			>
				<Braces className="size-icon-sm" />
				Templated
			</BadgeText>
		);
	}

	return (
		<BadgeText
			className="text-warning-text"
			title="These variables are not valid JSON, so the request will be sent without them."
		>
			<AlertCircle className="size-icon-sm" />
			Not sent
		</BadgeText>
	);
}

/**
 * What a `GET` will do with this document, when that is about to happen. Silent on other methods:
 * choosing GraphQL on a default `GET` moves it to `POST` (`graphql-method.ts`), so this renders for
 * a `GET` the user chose or an import wrote. A transport, not an error (`GET` is fine for a query,
 * wrong for a mutation), so the sentence names both and the method selector is one click away.
 */
function GetTransportBadge({ method }: { method: HttpMethod }) {
	if (!sendsGraphQLInTheUrl(method)) return null;

	return (
		<BadgeText
			className="text-muted-foreground"
			title="GraphQL over GET is sent as query parameters, not as a JSON body. A mutation needs POST."
		>
			<AlertCircle className="size-icon-sm" />
			Sent as query parameters
		</BadgeText>
	);
}

/** Where an insertion landed, in words a screen reader can use. */
const PLACEMENT_PHRASE: Record<DocumentInsertion["placement"], string> = {
	cursor: "at the cursor",
	ancestor: "into the enclosing selection",
	"new-operation": "as a new operation",
	fragment: "as a new fragment",
	argument: "as an argument",
};

const PANE_HEADER_CLASS =
	"flex h-band w-full items-center justify-between gap-2 px-3 border-b border-rule bg-panel shrink-0";

/**
 * A pane's header bar, fixed at `h-band`. A token, not padding plus content, because the Variables
 * pane collapses to exactly this bar and its `collapsedSize` (`GRAPHQL_PANE_HEADER_HEIGHT`, held
 * equal to `--spacing-band` by `titlebar-height.test.ts`) must match; padding would drift when a
 * control inside changed size.
 */
function PaneHeader({ children }: { children: React.ReactNode }) {
	return <div className={PANE_HEADER_CLASS}>{children}</div>;
}

/**
 * The same bar, as its pane's collapse control. The whole bar is the button, not a chevron in it: a
 * narrow activator in a wide box is the hit-area trap `drawer-row-hit-area` guards. The badges ride
 * inside as spans, readable while collapsed, when "2 variables need a value" most needs showing.
 */
function CollapsiblePaneHeader({
	collapsed,
	onToggle,
	children,
}: {
	collapsed: boolean;
	onToggle: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-expanded={!collapsed}
			className={cn(PANE_HEADER_CLASS, "text-left hover:bg-accent transition-colors")}
		>
			{children}
		</button>
	);
}

function PaneTitle({ children, collapsed }: { children: string; collapsed?: boolean }) {
	// `EYEBROW_CLASS`, not `Eyebrow`: inline in a `justify-between` bar beside a control, where the
	// primitive's `<p>` is the wrong element.
	if (collapsed === undefined) return <span className={EYEBROW_CLASS}>{children}</span>;
	return (
		<span className={cn(EYEBROW_CLASS, "flex items-center gap-1")}>
			{collapsed ? (
				<ChevronRight className="size-icon-sm" />
			) : (
				<ChevronDown className="size-icon-sm" />
			)}
			{children}
		</span>
	);
}

/**
 * Everything about the schema in one row that does not move: the pane toggle, the schema's state,
 * and Refresh.
 *
 * - **At the Query header's left edge**, where the pane arrives: the explorer is the first panel of
 *   the horizontal group below, so it opens to the *left* of the editors (#1224).
 * - **The same three parts open or closed**; only the toggle's icon and label flip.
 * - **Nothing is hover-revealed.** This is the app's only Refresh for the schema, always in one
 *   place, so "no duplicated Refresh" (#455) holds by construction, and a blind refresh (endpoint
 *   changed, an `Authorization` typed by hand, which the cache key cannot see) costs one click, not
 *   open, refresh and close (#507).
 *
 * Separate elements, since a button cannot nest in a button; the row makes them read as one
 * control.
 */
function SchemaControls({
	entry,
	awaitingLoad,
	open,
	onToggle,
	onRefresh,
}: {
	entry: SchemaEntry | null;
	/** The schema has not loaded because the endpoint is not yet one the user has contacted. */
	awaitingLoad: boolean;
	/** Whether the explorer pane is showing, for the toggle's icon and state. */
	open: boolean;
	onToggle: () => void;
	onRefresh: () => void;
}) {
	const loading = entry?.status === "loading";
	return (
		<span className="flex items-center gap-1">
			<TooltipIconButton
				label={open ? "Hide schema" : "Browse schema"}
				aria-expanded={open}
				className="shrink-0"
				icon={
					open ? (
						<PanelLeftClose className="size-icon-sm" />
					) : (
						<PanelLeftOpen className="size-icon-sm" />
					)
				}
				onClick={onToggle}
			/>
			{/*
			 * The badge carries the status in its own `title`, so no second tooltip (a Radix
			 * tooltip over a native one says it twice). Plain text, not a target (the two actions
			 * are the buttons beside it), except as Load schema while waiting for the user to
			 * contact the endpoint. An unknown schema is the badge's own `idle` face, and the badge
			 * holds its width in every state, so Refresh beside it never slides from under the
			 * pointer.
			 */}
			<SchemaStatusBadge entry={entry} awaitingLoad={awaitingLoad} onLoad={onRefresh} />
			<TooltipIconButton
				label="Refresh schema"
				className="shrink-0"
				icon={
					loading ? (
						<Loader2 className="size-icon-sm animate-spin" />
					) : (
						<RefreshCw className="size-icon-sm" />
					)
				}
				onClick={onRefresh}
				disabled={loading}
			/>
		</span>
	);
}

export function GraphQLBody({
	body,
	onBodyChange,
	requestId,
	schemaTarget,
	variablesDraft,
	onVariablesDraftChange,
	method,
	operationReference,
}: GraphQLBodyProps) {
	// One subscription, not three: the entry is the store's own reference, a stable snapshot, so
	// status, schema, error and freshness cannot be read a render apart.
	const entry = useSchemaCache((s) => s.getActiveEntry());
	const activeSchema = entry?.schema ?? null;
	const awaitingLoad = useSchemaCache((s) => !!s.activeKey && !!s.awaitingLoad[s.activeKey]);
	// Read so approving this endpoint elsewhere (Send here) re-runs the effect below, which loads
	// it.
	const approvedEndpoints = useClientSettingsStore((s) => s.approvedEndpoints);

	const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
	const [variablesModelUri, setVariablesModelUri] = useState<string | null>(null);
	/*
	 * The pane's markers come from a masked twin of its model, so a `{{token}}` (resolved and sent,
	 * as the badge says) is not a syntax error (`lib/graphql/variables-diagnostics.ts`). A ref
	 * because the twin outlives no mount: Radix tears this tab down on every glance elsewhere, and
	 * a leftover twin would keep validating a model nobody edits.
	 */
	const variablesDiagnostics = useRef<{ dispose: () => void } | null>(null);
	const attachVariablesModel = (
		monacoInstance: Parameters<OnMount>[1],
		model: editor.ITextModel | null
	) => {
		setVariablesModelUri(model?.uri.toString() ?? null);
		variablesDiagnostics.current?.dispose();
		variablesDiagnostics.current = model
			? attachVariablesDiagnostics(monacoInstance, model)
			: null;
	};
	const handleVariablesMount: OnMount = (editorInstance, monacoInstance) => {
		monacoRef.current = monacoInstance;
		attachVariablesModel(monacoInstance, editorInstance.getModel());
		// A request switch moves this editor to the next request's model (#3136); schema and twin
		// belong to the model, not the editor.
		editorInstance.onDidChangeModel(() =>
			attachVariablesModel(monacoInstance, editorInstance.getModel())
		);
	};
	useEffect(
		() => () => {
			variablesDiagnostics.current?.dispose();
			variablesDiagnostics.current = null;
		},
		[]
	);

	const explorerOpen = useExplorerStore((s) => s.open);
	const setExplorerOpen = useExplorerStore((s) => s.setOpen);
	const clearReveal = useRevealStore((s) => s.clearReveal);
	const queryEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
	/*
	 * State beside the ref, so a reveal command that arrived before Monaco loaded is served once it
	 * has: the editor mounts asynchronously, and this component mounts *because* of the command
	 * when the tab was hidden, so "no editor yet" is the ordinary path.
	 */
	const [queryEditorReady, setQueryEditorReady] = useState(false);
	const handleQueryMount: OnMount = (editorInstance) => {
		queryEditorRef.current = editorInstance;
		setQueryEditorReady(true);
	};

	/*
	 * The explorer's non-document outputs: what to say, and which variables the pane could not be
	 * given. The announcement is keyed as well as stored: a live region speaks only when its text
	 * *changes*, so a second identical insertion would be silent, reading as a missed click (as
	 * `ResponseAnnouncer` fixes it).
	 */
	const [announcement, setAnnouncement] = useState("");
	const [announcementSeq, setAnnouncementSeq] = useState(0);
	/*
	 * The announcement's words on screen, for the one outcome with nothing else to see: an
	 * insertion shows in the editor and an already-there selects its line, but a refusal reached
	 * only `sr-only` text, so a sighted click seemed to do nothing. Held here, where the decision
	 * is made, and cleared by the next landed activation. It carries its request and shows only
	 * while that request is on screen: nothing above is keyed on the request, so a tab switch would
	 * leave one request's notice describing another's. Compared during render, not cleared in an
	 * effect, so it never paints wrongly.
	 */
	const [explorerNotice, setExplorerNotice] = useState<{
		requestId: string | null;
		text: string;
	} | null>(null);
	const [pendingVariables, setPendingVariables] = useState<string[]>([]);
	// Stable, so the reveal effect can depend on it; the setters already are, this only says so.
	const announce = useCallback((message: string) => {
		setAnnouncement(message);
		setAnnouncementSeq((n) => n + 1);
	}, []);

	/*
	 * Where to put the caret once the new document reaches the editor, deferred to an effect: the
	 * pane is controlled by `value`, so at insertion Monaco still holds the old text. `CodeEditor`
	 * is a child, whose effects run first, so the model then holds the text the offset was computed
	 * on. A ref, not state: nothing renders it, and clearing state in its consuming effect is a
	 * second render per insertion (`react-hooks/set-state-in-effect` flags that).
	 */
	const pendingCursor = useRef<number | null>(null);

	// No endpoint, no schema to browse; the toggle is hidden for the same reason.
	const showExplorer = explorerOpen && !!schemaTarget.url;

	/*
	 * Track the endpoint as the active schema target and (debounced) introspect it, so the editors'
	 * language providers validate and complete against the real schema; `ensureSchema` does so only
	 * for an endpoint the user has contacted, else the badge offers Load schema. Keyed on the cache
	 * key, not the URL: credentials are part of the target, so another environment, auth block or
	 * variable they resolve through is another schema. The cleanup clears the target too: this
	 * mounts only in graphql mode, so unmounting is leaving GraphQL, and a target left set kept
	 * Monaco completing a closed tab's endpoint. Guarded on still being active, so a request switch
	 * (which mounts the next body first) does not blank the new one.
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
		// `targetKey` is `schemaTarget` serialized, the identity keyed on above; `schemaTarget` is
		// rebuilt every render, so depending on it re-introspects per keystroke.
		// `approvedEndpoints` is unread in the body: it re-runs the effect when the user contacts
		// this endpoint, so a declined schema loads.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [targetKey, approvedEndpoints]);

	/*
	 * Everything the envelope carries, from the body. The query and `operationName` are always
	 * valid strings and `extras` holds the rest; all three ride on every write, so a keystroke in
	 * either pane deletes none.
	 */
	const parts = useMemo(() => parseGraphQLBody(body || ""), [body]);
	const query = parts.query;

	/*
	 * The variables editor keeps its raw text as the truth: mid-typing states are invalid JSON that
	 * `serializeGraphQLBody` drops, so re-deriving from the body would wipe input. It re-syncs only
	 * on external changes (request or mode switch), tracked via the body last written. The draft
	 * makes this survive an unmount: seeded from the body alone, the text the body could not carry
	 * would be lost.
	 */
	const [variables, setVariables] = useState(
		() => variablesDraft ?? parseGraphQLBody(body || "").variables
	);
	/*
	 * A request switch re-seeds the pane in the render carrying the new request, not in the effect:
	 * the model changes with the request, and one made or edited from the previous text in between
	 * is the cross-request undo this keying prevents (#3136).
	 */
	const [variablesFor, setVariablesFor] = useState(requestId);
	if (variablesFor !== requestId) {
		setVariablesFor(requestId);
		setVariables(parseGraphQLBody(body || "").variables);
	}
	// Seeded with the mounted body so the effect does not re-derive the pane and discard the
	// restored draft.
	const lastWrittenBody = useRef<string | undefined>(body);
	useEffect(() => {
		if (body === lastWrittenBody.current) return;
		const next = parseGraphQLBody(body || "").variables;
		setVariables(next);
		onVariablesDraftChange(next);
		lastWrittenBody.current = body;
	}, [body, onVariablesDraftChange]);

	/*
	 * One write path, taking only what changed; the rest comes from `parts` (the stored envelope)
	 * and `variables` (the pane's draft, ahead of the body mid-edit), so no caller drops a field by
	 * not naming it.
	 */
	const write = (changed: Partial<GraphQLBodyParts>) => {
		const next = serializeGraphQLBody({ ...parts, variables, ...changed });
		lastWrittenBody.current = next;
		onBodyChange(next);
	};

	/*
	 * A document with two operations must say which to run: the spec forbids an anonymous operation
	 * beside a named one, and a server given no `operationName` errors. So the picker appears when
	 * the choice is real. An `operationName` the document no longer defines (renamed, or mid-edit)
	 * is still what is sent, so it stays an option: the trigger shows the truth, and nothing
	 * rewrites the body.
	 */
	const names = useMemo(() => operationNames(query), [query]);
	const operations =
		parts.operationName && !names.includes(parts.operationName)
			? [...names, parts.operationName]
			: names;

	// The variables editor's JSON schema comes from the query's `$variables` plus the introspected
	// schema, so it validates and completes against what the operation expects.
	useEffect(() => {
		const monaco = monacoRef.current;
		if (!monaco || !variablesModelUri) return;
		applyVariablesSchema(monaco, variablesModelUri, query, activeSchema);
	}, [query, activeSchema, variablesModelUri]);

	const refresh = () => {
		if (!schemaTarget.url) return;
		void useSchemaCache.getState().refreshSchema(schemaTarget);
	};

	/*
	 * The Variables pane's collapse, from the store, not the panel: the panel's memory dies with
	 * the mount, and Radix unmounts this on every glance at Headers (why the body drafts and
	 * explorer store exist). A drag that collapses it reports through `onResize`, so the two agree
	 * either way.
	 */
	const variablesPanel = useRef<PanelImperativeHandle | null>(null);
	const variablesCollapsed = useLayoutStore((s) => s.graphqlVariablesCollapsed);
	const variablesSize = useLayoutStore((s) => s.graphqlVariablesSize);
	const setVariablesCollapsed = useLayoutStore((s) => s.setGraphqlVariablesCollapsed);
	const setVariablesSize = useLayoutStore((s) => s.setGraphqlVariablesSize);

	useEffect(() => {
		const panel = variablesPanel.current;
		if (!panel) return;
		if (variablesCollapsed) {
			if (!panel.isCollapsed()) panel.collapse();
			return;
		}
		/*
		 * `resize` to the remembered size, not `expand`: the panel's "most recent size" is only
		 * this mount's, so after a tab glance `expand` would open at the minimum.
		 */
		if (panel.isCollapsed()) panel.resize(`${useLayoutStore.getState().graphqlVariablesSize}%`);
	}, [variablesCollapsed]);

	// Debounced as the request/response split is: a drag fires per frame, and the store writes to
	// localStorage.
	const sizeSaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => () => clearTimeout(sizeSaveTimeout.current ?? undefined), []);
	const handleVariablesResize = (
		size: { asPercentage: number },
		_id: string | number | undefined,
		previous: { asPercentage: number } | undefined
	) => {
		/*
		 * The mount call (no previous size) is the panel echoing what we told it; reading collapse
		 * state from it would let an unsettled layout overwrite the preference that produced it.
		 */
		if (!previous) return;
		const panel = variablesPanel.current;
		const collapsed = panel?.isCollapsed() ?? false;
		if (collapsed !== useLayoutStore.getState().graphqlVariablesCollapsed) {
			setVariablesCollapsed(collapsed);
		}
		// A collapsed panel's size is the header bar, not a height to return to.
		if (collapsed) return;
		if (sizeSaveTimeout.current) clearTimeout(sizeSaveTimeout.current);
		sizeSaveTimeout.current = setTimeout(() => setVariablesSize(size.asPercentage), 200);
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

	/*
	 * Scroll to the operation the context bar's outline asked for, resolved against *this*
	 * document: the bar reads the stored request, the editor the live buffer, which differ by
	 * unsaved autosave (`findOperationLine`). The command is cleared once served **and** when it
	 * cannot be (an operation renamed since is not found), since a command left in the slot replays
	 * on the next render and remount, which Body does on every glance at Headers. It is kept only
	 * while Monaco has not mounted: it is served when the editor arrives.
	 */
	useEffect(() => {
		const serve = (command: OperationRevealCommand | null) => {
			if (!command || command.requestId !== requestId) return;
			const instance = queryEditorReady ? queryEditorRef.current : null;
			if (!instance) return;
			clearReveal();
			const line = findOperationLine(query, command);
			if (line === null) {
				announce(`${command.name ?? "That operation"} is no longer in this document.`);
				return;
			}
			instance.setPosition({ lineNumber: line, column: 1 });
			instance.revealLineInCenter(line);
			instance.focus();
		};
		// Read as well as subscribed: from a hidden Body tab the command was written before this
		// mounted.
		serve(useRevealStore.getState().pending);
		return useRevealStore.subscribe((s) => serve(s.pending));
	}, [requestId, query, queryEditorReady, clearReveal, announce]);

	/**
	 * Inserts what the explorer row stands for, and says what happened. Query and variables are
	 * written in **one** `serializeGraphQLBody` call: two would each re-serialise from `parts`, and
	 * the second, from this render's closure, would carry the pre-merge variables and undo the
	 * first.
	 */
	const handleExplorerInsert = (node: SchemaTreeNode) => {
		if (!activeSchema) return;
		const model = queryEditorRef.current?.getModel();
		const position = queryEditorRef.current?.getPosition();
		const cursor = model && position ? model.getOffsetAt(position) : query.length;

		const result = insertionForNode(activeSchema, node, query, cursor);
		if (!result) return;
		if (isRefusal(result)) {
			setExplorerNotice({ requestId, text: result.reason });
			announce(result.reason);
			return;
		}
		setExplorerNotice(null);
		/*
		 * The leaf is already there: show the line instead of writing a second, selected rather
		 * than scrolled to, so Monaco's selection paints it, not a hand-rolled highlight.
		 */
		if (isAlreadyPresent(result)) {
			const instance = queryEditorRef.current;
			if (instance && model) {
				const from = model.getPositionAt(result.start);
				const to = model.getPositionAt(result.end);
				instance.setSelection({
					startLineNumber: from.lineNumber,
					startColumn: from.column,
					endLineNumber: to.lineNumber,
					endColumn: to.column,
				});
				instance.revealLineInCenter(from.lineNumber);
				instance.focus();
			}
			announce(`${result.label} is already selected.`);
			return;
		}

		const merged = mergeVariables(variables, result.variables);
		setVariables(merged.text);
		onVariablesDraftChange(merged.text);
		setPendingVariables(merged.pending);
		/*
		 * An insertion that could not write its variables made the pane the thing to look at, so a
		 * collapsed pane opens: the badge names values the user must now type, and typing needs the
		 * editor.
		 */
		if (merged.pending.length > 0) setVariablesCollapsed(false);

		const next = serializeGraphQLBody({
			...parts,
			query: result.text,
			variables: merged.text,
		});
		lastWrittenBody.current = next;
		onBodyChange(next);
		pendingCursor.current = result.cursor;

		const unwritten = merged.pending.length
			? ` ${merged.pending.length} ${pluralize(merged.pending.length, "variable needs", "variables need")} a value: ${merged.pending.join(", ")}.`
			: "";
		announce(`Inserted ${result.label} ${PLACEMENT_PHRASE[result.placement]}.${unwritten}`);
	};

	const editors = (
		<ResizablePanelGroup orientation="vertical" className="h-full">
			<ResizablePanel defaultSize="65%" minSize="25%" className="flex flex-col">
				<PaneHeader>
					{/*
					 * The schema control leads, on the edge the explorer opens from, then the
					 * title; grouped, since the bar's `justify-between` would push the title to the
					 * middle.
					 */}
					<span className="flex items-center gap-2 min-w-0">
						{schemaTarget.url && (
							<SchemaControls
								entry={entry}
								awaitingLoad={awaitingLoad}
								open={showExplorer}
								onToggle={() => setExplorerOpen(!showExplorer)}
								onRefresh={refresh}
							/>
						)}
						<PaneTitle>Query</PaneTitle>
					</span>
					<div className="flex items-center gap-2">
						<GetTransportBadge method={method} />
						{names.length > 1 && (
							<Select
								value={parts.operationName}
								onValueChange={(name) => write({ operationName: name })}
							>
								<SelectTrigger
									className="h-control-sm w-auto gap-1 px-2 text-label"
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
						{/*
						 * Beside the picker, not in it (a button in a Select trigger opens the
						 * list). It follows the picker's rule (a real choice) and needs the name
						 * the envelope sends.
						 */}
						{names.length > 1 &&
							parts.operationName &&
							names.includes(parts.operationName) &&
							operationReference && (
								<CopyForAgentButton
									reference={operationReference(parts.operationName)}
									label="Copy operation for agent"
								/>
							)}
					</div>
				</PaneHeader>
				{/*
				 * `min-h-0`: a flex item will not shrink below content, so the editor kept its
				 * height when the pane was dragged smaller and the panel grew a second scrollbar
				 * beside the editor's. As `min-w-0` on truncating rows.
				 */}
				<div className="min-h-0 flex-1">
					<CodeEditor
						height="100%"
						language="graphql"
						ariaLabel="GraphQL query"
						path={requestModelPath(requestId, "graphql-query")}
						value={query}
						onChange={(q) => write({ query: q ?? "" })}
						onMount={handleQueryMount}
					/>
				</div>
			</ResizablePanel>

			{/*
			 * A hairline, no grip: it splits two editors inside the box; the handle below resizes
			 * the box.
			 */}
			<ResizableHandle className="h-px w-full cursor-row-resize bg-rule hover:bg-primary transition-colors" />

			{/*
			 * Collapsible: a `{ "code": "IN" }` document is two lines, and the pane took a third of
			 * the stack. Collapsed it is its own header and the query editor takes the height.
			 * `collapsedSize` in pixels: the bar is a fixed 28px whatever the stack height, and a
			 * percentage would clip it in a short pane and leave dead editor in a tall one.
			 */}
			<ResizablePanel
				panelRef={variablesPanel}
				collapsible
				collapsedSize={`${GRAPHQL_PANE_HEADER_HEIGHT}px`}
				defaultSize={
					variablesCollapsed ? `${GRAPHQL_PANE_HEADER_HEIGHT}px` : `${variablesSize}%`
				}
				minSize={`${GRAPHQL_VARIABLES_MIN_SIZE}%`}
				maxSize={`${GRAPHQL_VARIABLES_MAX_SIZE}%`}
				onResize={handleVariablesResize}
				className="flex flex-col"
			>
				<CollapsiblePaneHeader
					collapsed={variablesCollapsed}
					onToggle={() => setVariablesCollapsed(!variablesCollapsed)}
				>
					<PaneTitle collapsed={variablesCollapsed}>Variables</PaneTitle>
					<div className="flex items-center gap-2">
						<PendingVariablesBadge names={pendingVariables} />
						<VariablesFormBadge form={classifyVariables(variables)} />
					</div>
				</CollapsiblePaneHeader>
				<div className="min-h-0 flex-1">
					<CodeEditor
						height="100%"
						language="json"
						ariaLabel="GraphQL variables"
						path={requestModelPath(requestId, "graphql-variables")}
						value={variables}
						onChange={(v) => {
							setVariables(v ?? "");
							onVariablesDraftChange(v ?? "");
							write({ variables: v ?? "" });
							/*
							 * Once the user touches the pane it is their text, and a stale list of
							 * names they may have just typed is worse than none.
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
		 * One horizontal group, always: rendering it only with the explorer open would move the
		 * editors in the tree on every toggle, and remounting Monaco loses undo and scroll. Keys
		 * hold the editors' identity across the conditional siblings.
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
						entry={entry}
						schemaKey={targetKey}
						onInsert={handleExplorerInsert}
						notice={
							explorerNotice?.requestId === requestId ? explorerNotice.text : null
						}
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
			 * Mounted whether or not it has anything to say: a region added with its first message
			 * is not announced (the trap `ResponseAnnouncer` and the Toaster record).
			 */}
			<div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
				<span key={announcementSeq}>{announcement}</span>
			</div>
		</ResizablePanelGroup>
	);
}

/**
 * Variables an insertion declared but could not write, as the pane held text that was not strict
 * JSON. Overwriting the pane would delete a working `{{token}}` draft for a placeholder; naming
 * them closes the silent gap between the query and the values it needs.
 */
function PendingVariablesBadge({ names }: { names: string[] }) {
	if (names.length === 0) return null;
	return (
		<BadgeText
			className="text-warning-text"
			title={`The Variables pane is not plain JSON, so these were not added: ${names.join(", ")}.`}
		>
			<AlertCircle className="size-icon-sm" />
			{`${names.length} ${pluralize(names.length, "variable needs", "variables need")} a value`}
		</BadgeText>
	);
}

export default GraphQLBody;
