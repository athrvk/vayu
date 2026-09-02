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
import { SchemaExplorer } from "./graphql-explorer/SchemaExplorer";
import { BadgeText, SchemaStatusBadge } from "./SchemaStatusBadge";
import { sendsGraphQLInTheUrl } from "./graphql-method";
import { schemaStatusTitle } from "@/lib/graphql/schema-status";
import { useLayoutStore } from "@/stores";
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

export interface GraphQLBodyProps {
	body: string;
	onBodyChange: (body: string) => void;
	/**
	 * Whose body this is. Read only to tell a reveal command written for this
	 * request from one written for another, for the reason the body drafts carry
	 * the same field (`utils/body-drafts.ts`).
	 */
	requestId: string | null;
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
	/**
	 * The method this request will be sent with.
	 *
	 * Read for one thing: GraphQL over `GET` is a different transport - the
	 * document travels as query parameters and a mutation cannot be sent that
	 * way - and the Query header says so when that is what will happen
	 * (issue #1228).
	 */
	method: HttpMethod;
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

/**
 * What a `GET` will do with this document, when that is what is about to happen.
 *
 * Nothing at all on any other method, which is the common case: choosing the
 * GraphQL mode on a request still holding the default `GET` moves it to `POST`
 * (`graphql-method.ts`), so this renders for a `GET` the user chose themselves
 * or one an import wrote. It describes a transport rather than reporting an
 * error - `GET` is a legitimate way to send a query, and the wrong way to send
 * a mutation - which is why the sentence names both halves and the method
 * selector is one click away.
 */
function GetTransportBadge({ method }: { method: HttpMethod }) {
	if (!sendsGraphQLInTheUrl(method)) return null;

	return (
		<BadgeText
			className="text-muted-foreground"
			title="GraphQL over GET is sent as query parameters, not as a JSON body. A mutation needs POST."
		>
			<AlertCircle className="w-3 h-3" />
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
};

const PANE_HEADER_CLASS =
	"flex w-full items-center justify-between gap-2 px-3 border-b border-border bg-panel shrink-0";

/**
 * A pane's header bar, fixed at `GRAPHQL_PANE_HEADER_HEIGHT`.
 *
 * The height is a constant rather than padding-plus-content because the
 * Variables pane collapses to exactly this bar, and the panel's `collapsedSize`
 * has to be the same number. Padding that happened to add up would drift the
 * first time a control inside changed size.
 */
function PaneHeader({ children }: { children: React.ReactNode }) {
	return (
		<div className={PANE_HEADER_CLASS} style={{ height: GRAPHQL_PANE_HEADER_HEIGHT }}>
			{children}
		</div>
	);
}

/**
 * The same bar, as the control that collapses its pane.
 *
 * The whole bar is the button rather than a chevron inside it: a header with a
 * narrow activator and a wide box is the composite-row hit-area trap
 * `drawer-row-hit-area` was written against. The badges ride inside it as
 * spans, which is what keeps them readable while the pane is collapsed - the
 * moment "2 variables need a value" most needs to be on screen.
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
			style={{ height: GRAPHQL_PANE_HEADER_HEIGHT }}
		>
			{children}
		</button>
	);
}

function PaneTitle({ children, collapsed }: { children: string; collapsed?: boolean }) {
	// `EYEBROW_CLASS` rather than the `Eyebrow` component: this sits in a
	// `flex items-center justify-between` bar beside a control, where the
	// primitive's `<p>` would be the wrong element for an inline label.
	if (collapsed === undefined) return <span className={EYEBROW_CLASS}>{children}</span>;
	return (
		<span className={cn(EYEBROW_CLASS, "flex items-center gap-1")}>
			{collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
			{children}
		</span>
	);
}

/**
 * Everything about the schema, in one row that does not move: the toggle for
 * the pane, what state the schema is in, and Refresh.
 *
 * **It sits at the Query header's left edge because that is the edge the pane
 * arrives at.** The explorer is the first panel of the horizontal group below,
 * so it opens to the *left* of these editors, while the control that opened it
 * used to sit at the far right of this header drawing a `PanelRightOpen` - a
 * user reaching for the side the pane appears on found nothing, and the icon
 * named the opposite side outright (#1224).
 *
 * **The same three parts render whether the pane is open or closed.** Only the
 * toggle's icon and label flip. The layout used to be a different shape per
 * state - a chip here while closed, a badge and two icons in the pane's header
 * while open - which taught a position and then abandoned it.
 *
 * **Nothing here is hover-revealed.** #455 made "no duplicated Refresh"
 * structural by moving the only one into the explorer, which left a blind
 * refresh - the endpoint changed, or an `Authorization` was typed by hand, and
 * the cache key cannot see either - costing open-the-pane plus refresh plus
 * close again (#507). The answer then was a Refresh transparent at rest, which
 * bought *one standing Refresh* at the price of a control the user had to know
 * about already. This is now the app's only Refresh for the subject, standing in
 * one place, so the rule holds by construction rather than by transparency.
 *
 * The three parts are separate elements because a button cannot nest in a
 * button - the row is what makes them read as one control.
 */
function SchemaControls({
	entry,
	open,
	onToggle,
	onRefresh,
}: {
	entry: SchemaEntry | null;
	/** Whether the explorer pane is showing, for the toggle's icon and state. */
	open: boolean;
	onToggle: () => void;
	onRefresh: () => void;
}) {
	const status = entry?.status ?? "idle";
	const loading = status === "loading";
	return (
		<span className="flex items-center gap-1">
			<TooltipIconButton
				label={open ? "Hide schema" : "Browse schema"}
				aria-expanded={open}
				className="h-5 w-5 shrink-0"
				icon={
					open ? (
						<PanelLeftClose className="w-3 h-3" />
					) : (
						<PanelLeftOpen className="w-3 h-3" />
					)
				}
				onClick={onToggle}
			/>
			{/*
			 * The badge carries the status sentence in its own `title`, so it wears
			 * no second tooltip: a Radix tooltip over an element that already has a
			 * native one is the same fact told twice. It is plain text rather than
			 * a target - the two things a user does about the schema are the
			 * buttons on either side of it.
			 *
			 * A schema nothing has been said about yet falls back to a plain label
			 * rather than the badge's `null`, so the row keeps its shape from the
			 * first render.
			 */}
			{status === "idle" ? (
				<BadgeText className="text-muted-foreground" title={schemaStatusTitle(entry)}>
					Schema
				</BadgeText>
			) : (
				<SchemaStatusBadge entry={entry} />
			)}
			<TooltipIconButton
				label="Refresh schema"
				className="h-5 w-5 shrink-0"
				icon={
					loading ? (
						<Loader2 className="w-3 h-3 animate-spin" />
					) : (
						<RefreshCw className="w-3 h-3" />
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
	onEditorMount,
	variablesDraft,
	onVariablesDraftChange,
	method,
}: GraphQLBodyProps) {
	// One subscription, not three: the entry object is the store's own reference,
	// so it is a stable snapshot, and status/schema/error/freshness cannot be
	// read a render apart from each other.
	const entry = useSchemaCache((s) => s.getActiveEntry());
	const activeSchema = entry?.schema ?? null;

	const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
	const [variablesModelUri, setVariablesModelUri] = useState<string | null>(null);
	/*
	 * The pane's markers come from a masked twin of its model, so that a
	 * `{{token}}` - which the badge above says is resolved and sent - stops
	 * reading as a syntax error (`lib/graphql/variables-diagnostics.ts`). Held in
	 * a ref because the twin outlives no mount: Radix tears this tab down on
	 * every glance at another one, and a twin left behind would keep validating a
	 * model nobody is editing.
	 */
	const variablesDiagnostics = useRef<{ dispose: () => void } | null>(null);
	const handleVariablesMount: OnMount = (editorInstance, monacoInstance) => {
		onEditorMount(editorInstance, monacoInstance);
		monacoRef.current = monacoInstance;
		const model = editorInstance.getModel();
		setVariablesModelUri(model?.uri.toString() ?? null);
		variablesDiagnostics.current?.dispose();
		variablesDiagnostics.current = model
			? attachVariablesDiagnostics(monacoInstance, model)
			: null;
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
	 * State beside the ref, so that a reveal command which arrived before Monaco
	 * finished loading is served once it has. The editor mounts asynchronously,
	 * and this component mounts *because* of the command in the tab-was-hidden
	 * case, so "no editor yet" is the ordinary path rather than the odd one.
	 */
	const [queryEditorReady, setQueryEditorReady] = useState(false);
	const handleQueryMount: OnMount = (editorInstance, monacoInstance) => {
		onEditorMount(editorInstance, monacoInstance);
		queryEditorRef.current = editorInstance;
		setQueryEditorReady(true);
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
	// Stable, so the reveal effect below can depend on it without re-running per
	// render. The two setters are stable already; this only says so.
	const announce = useCallback((message: string) => {
		setAnnouncement(message);
		setAnnouncementSeq((n) => n + 1);
	}, []);

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
		// `targetKey` is `schemaTarget` serialized, which is the identity the
		// comment above keys on; `schemaTarget` itself is rebuilt every render,
		// so depending on it would re-introspect the same endpoint on every
		// keystroke.
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

	/*
	 * The Variables pane's collapse, driven from the store rather than from the
	 * panel.
	 *
	 * The store is the truth and the panel follows it, not the other way round,
	 * because the panel's own memory dies with the mount - and this component is
	 * unmounted every time Radix glances at the Headers tab, which is the whole
	 * reason the body drafts and the explorer store exist. A drag that collapses
	 * the pane reports back through `onResize`, so the two agree whichever end
	 * the user reached for.
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
		 * `resize` to the remembered size rather than `expand`: the panel's
		 * "most recent size" is only whatever this mount has seen, so after a tab
		 * glance `expand` would open to the minimum instead of the height the
		 * user left it at.
		 */
		if (panel.isCollapsed()) panel.resize(`${useLayoutStore.getState().graphqlVariablesSize}%`);
	}, [variablesCollapsed]);

	/*
	 * Debounced for the same reason the request/response split is: a drag fires
	 * this on every frame, and the store writes through to localStorage.
	 */
	const sizeSaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => () => clearTimeout(sizeSaveTimeout.current ?? undefined), []);
	const handleVariablesResize = (
		size: { asPercentage: number },
		_id: string | number | undefined,
		previous: { asPercentage: number } | undefined
	) => {
		/*
		 * The mount call - the one with no previous size - is the panel telling
		 * us what we just told it. Reading collapse state back from it would let
		 * a layout that has not settled overwrite the preference that produced
		 * it, and there is nothing to learn from it either way.
		 */
		if (!previous) return;
		const panel = variablesPanel.current;
		const collapsed = panel?.isCollapsed() ?? false;
		if (collapsed !== useLayoutStore.getState().graphqlVariablesCollapsed) {
			setVariablesCollapsed(collapsed);
		}
		// A collapsed panel's size is the header bar, which is not a height to
		// come back to.
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
	 * Scroll to the operation the context bar's outline asked for.
	 *
	 * Resolved against *this* document rather than trusting a line the outline
	 * drew: the bar reads the stored request and the editor holds the live
	 * buffer, so the two differ by whatever autosave has not written yet
	 * (`findOperationLine`).
	 *
	 * The command is cleared once served **and** when it cannot be - an
	 * operation renamed since the outline was drawn is not found, and a command
	 * left in the slot is replayed on the next render and on the next remount,
	 * which the Body tab does on every glance at Headers. The one case that does
	 * *not* clear is Monaco not having mounted yet: there is nothing to serve the
	 * command with, and it is served a moment later when the editor arrives.
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
		// The slot is read as well as subscribed to: in the case this exists for -
		// a click from a hidden Body tab - the command was written before this
		// component was mounted to hear about it.
		serve(useRevealStore.getState().pending);
		return useRevealStore.subscribe((s) => serve(s.pending));
	}, [requestId, query, queryEditorReady, clearReveal, announce]);

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
		/*
		 * The leaf is already in the set the click would have added it to. Show
		 * the user the line they already have instead of writing a second one -
		 * selected, not merely scrolled to, so the editor's own selection paints
		 * it rather than a highlight hand-rolled beside the one Monaco owns.
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
		 * An insertion that could not write its variables has just made the pane
		 * the thing to look at, so a collapsed pane opens itself. This is the one
		 * moment the badge is not enough on its own: it names variables the user
		 * now has to type values into, and typing needs the editor.
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
			? ` ${merged.pending.length} ${merged.pending.length === 1 ? "variable needs" : "variables need"} a value: ${merged.pending.join(", ")}.`
			: "";
		announce(`Inserted ${result.label} ${PLACEMENT_PHRASE[result.placement]}.${unwritten}`);
	};

	const editors = (
		<ResizablePanelGroup orientation="vertical" className="h-full">
			<ResizablePanel defaultSize="65%" minSize="25%" className="flex flex-col">
				<PaneHeader>
					{/*
					 * The schema control leads the header, on the edge the explorer
					 * opens from; the title follows it. Grouped rather than left as
					 * three children of the bar, whose `justify-between` would push
					 * the title into the middle.
					 */}
					<span className="flex items-center gap-2 min-w-0">
						{schemaTarget.url && (
							<SchemaControls
								entry={entry}
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
						ariaLabel="GraphQL query"
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

			{/*
			 * Collapsible, because a `{ "code": "IN" }` document is two lines and
			 * the pane reserved a third of the stack for it. Collapsed it is its
			 * own header, and the query editor takes the height back.
			 *
			 * `collapsedSize` in pixels rather than a percentage: the bar it
			 * collapses to is a fixed 28px whatever the stack's own height is,
			 * and a percentage would clip it in a short pane and leave dead
			 * editor under it in a tall one.
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
						entry={entry}
						schemaKey={targetKey}
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
