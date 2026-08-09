/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The schema explorer: the endpoint's own documentation, beside the editor that
 * needs it.
 *
 * **Beside the editor, not in the context bar.** The bar clamps to 220-480px
 * (`layout-store`), which is where Postman's explorer already lives and why
 * theirs reads as a cramped list rather than a document. Insertion also wants
 * to be next to the cursor it inserts at. The bar gets the *status* half in its
 * own section - freshness and an outline are glanceable, browsing is not.
 *
 * **It adds no introspection of its own.** The pane renders whatever the schema
 * cache is holding, and its Refresh button is the same one the query pane's
 * header already offers. #382 made the body-tab lifecycle the whole consent
 * budget for talking to the endpoint, and a pane that fetched on open would
 * quietly widen it.
 *
 * Search, expansion and scroll live in `explorer-store`, not in this component:
 * Radix unmounts the whole Body tab whenever the user glances at Headers, and
 * state here would not survive it.
 */

import { useCallback, useMemo, useRef } from "react";
import { AlertCircle, ChevronDown, ChevronRight, Loader2, RefreshCw, Search } from "lucide-react";
import type { GraphQLSchema } from "graphql";
import { Input, TooltipIconButton, EYEBROW_CLASS } from "@/components/ui";
import { useGrowingWindow } from "@/hooks/useGrowingWindow";
import { useRovingTreeFocus } from "@/modules/collections/useRovingTreeFocus";
import { useExplorerStore } from "@/lib/graphql/explorer-store";
import {
	buildSearchIndex,
	searchSchema,
	visibleRows,
	type SchemaTreeNode,
} from "@/lib/graphql/schema-tree";
import type { SchemaStatus } from "@/lib/graphql/schema-cache";
import { formatRelativeTime } from "@/utils/helpers";
import { cn } from "@/lib/utils";

/** How many rows to render before the window grows. */
const ROW_WINDOW = 200;
/** One level of indentation, in pixels. Matches the collection tree's step. */
const INDENT_STEP = 12;

export interface SchemaExplorerProps {
	schema: GraphQLSchema | null;
	status: SchemaStatus;
	/** When the schema in hand was fetched, or null when there is none. */
	fetchedAt: number | null;
	/** The schema's cache identity - what the view state is remembered under. */
	schemaKey: string;
	onRefresh: () => void;
	/**
	 * Insert this row into the query document. The explorer does not know what
	 * the document is; it knows which row was activated.
	 */
	onInsert: (node: SchemaTreeNode) => void;
}

export function SchemaExplorer({
	schema,
	status,
	fetchedAt,
	schemaKey,
	onRefresh,
	onInsert,
}: SchemaExplorerProps) {
	const view = useExplorerStore((s) => s.byKey[schemaKey]);
	const search = view?.search ?? "";
	const setSearch = useExplorerStore((s) => s.setSearch);
	const toggleExpanded = useExplorerStore((s) => s.toggleExpanded);
	const setScrollTop = useExplorerStore((s) => s.setScrollTop);

	const treeRef = useRef<HTMLDivElement | null>(null);
	const searchRef = useRef<HTMLInputElement | null>(null);
	const roving = useRovingTreeFocus(treeRef);

	const expanded = useMemo(() => new Set(view?.expanded ?? []), [view?.expanded]);

	const rows = useMemo(() => {
		if (!schema) return [];
		if (search.trim()) {
			const matches = searchSchema(buildSearchIndex(schema), search);
			return matches.map((m) => ({ node: m.node, depth: 0 }));
		}
		return visibleRows(schema, expanded);
	}, [schema, search, expanded]);

	const { visible, sentinelRef, hasMore } = useGrowingWindow(rows.length, ROW_WINDOW);

	/*
	 * Restore the scroll position the last mount left behind.
	 *
	 * A callback ref rather than an effect: the scroller mounts and unmounts
	 * with the Body tab, and the position has to be written the moment the node
	 * exists, before the browser paints the top of the list. Reading the store
	 * through `getState` keeps this off the subscription - the scroll handler
	 * writes on every frame of a drag, and re-rendering the tree for it would
	 * be a render per scroll tick.
	 */
	const scrollerRef = useCallback(
		(node: HTMLDivElement | null) => {
			if (node) node.scrollTop = useExplorerStore.getState().view(schemaKey).scrollTop;
		},
		[schemaKey]
	);

	/*
	 * `/` focuses the search box, the way it does in a document viewer - and
	 * only when the user is not already typing into one, since a slash is a
	 * legitimate character in a search term. Everything else is the treeview
	 * pattern, which `useRovingTreeFocus` already implements; this wraps it
	 * rather than restating it, so the tree keeps whatever that hook learns.
	 */
	const onKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			const target = e.target as HTMLElement;
			if (e.key === "/" && target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") {
				e.preventDefault();
				searchRef.current?.focus();
				return;
			}
			roving.onKeyDown(e);
		},
		[roving]
	);

	const age = fetchedAt ? `Schema from ${formatRelativeTime(fetchedAt)}` : null;

	return (
		<div className="flex flex-col h-full min-h-0 bg-panel" data-testid="graphql-explorer">
			<div className="flex items-center gap-1 px-2 py-1 border-b border-border shrink-0">
				<div className="relative flex-1 min-w-0">
					<Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
					<Input
						ref={searchRef}
						value={search}
						onChange={(e) => setSearch(schemaKey, e.target.value)}
						placeholder="Search schema"
						aria-label="Search schema"
						className="h-6 pl-6 text-[11px]"
					/>
				</div>
				<TooltipIconButton
					label="Refresh schema"
					className="h-6 w-6 shrink-0"
					icon={
						status === "loading" ? (
							<Loader2 className="w-3 h-3 animate-spin" />
						) : (
							<RefreshCw className="w-3 h-3" />
						)
					}
					onClick={onRefresh}
					disabled={status === "loading"}
				/>
			</div>

			{/*
			 * A stale schema browses, with its age stated. Blanking the pane on a
			 * failed refresh would throw away the only answer available - the
			 * same call `schema-cache` makes when it keeps the last good schema.
			 */}
			{schema && status === "error" && (
				<p className="flex items-center gap-1 px-2 py-1 m-0 text-[10px] text-warning-text border-b border-border shrink-0">
					<AlertCircle className="w-3 h-3 shrink-0" />
					{age ? `${age}. Refresh failed.` : "Refresh failed."}
				</p>
			)}

			<div
				ref={scrollerRef}
				className="flex-1 min-h-0 overflow-auto"
				onScroll={(e) => setScrollTop(schemaKey, e.currentTarget.scrollTop)}
			>
				{!schema ? (
					<p className="px-2 py-2 m-0 text-[11px] text-muted-foreground">
						{status === "loading"
							? "Loading the schema…"
							: "No schema loaded. Refresh to introspect the endpoint."}
					</p>
				) : rows.length === 0 ? (
					<p className="px-2 py-2 m-0 text-[11px] text-muted-foreground">
						Nothing matches "{search.trim()}".
					</p>
				) : (
					<div
						ref={treeRef}
						role="tree"
						aria-label="Schema"
						onKeyDown={onKeyDown}
						onFocus={roving.onFocus}
					>
						{rows.slice(0, visible).map(({ node, depth }) => (
							<ExplorerRow
								key={node.id}
								node={node}
								depth={depth}
								expanded={expanded.has(node.id)}
								onToggle={() => toggleExpanded(schemaKey, node.id)}
								onInsert={() => onInsert(node)}
							/>
						))}
						{hasMore && (
							<div ref={sentinelRef} className="px-2 py-1">
								<span className={EYEBROW_CLASS}>
									Showing {visible} of {rows.length}
								</span>
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

interface ExplorerRowProps {
	node: SchemaTreeNode;
	depth: number;
	expanded: boolean;
	onToggle: () => void;
	onInsert: () => void;
}

function ExplorerRow({ node, depth, expanded, onToggle, onInsert }: ExplorerRowProps) {
	const deprecated = node.deprecationReason !== null;
	const title = [
		node.description,
		deprecated ? `Deprecated: ${node.deprecationReason}` : null,
		node.branch === "subscription" && node.kind === "field"
			? "Subscriptions cannot be run here - the engine sends one HTTP request and reads one response."
			: null,
	]
		.filter(Boolean)
		.join("\n");

	return (
		/*
		 * The row is the perceived target and paints the hover fill; the
		 * activator inside it is `self-stretch` so the fill and the hit area are
		 * the same rectangle. A content-height activator in an `items-center`
		 * row leaves the top and bottom of every row dead - measured at over 40%
		 * of the drawer's rows before `drawer-row-hit-area` pinned it.
		 */
		<div
			role="treeitem"
			aria-expanded={node.expandable ? expanded : undefined}
			aria-level={depth + 1}
			data-tree-label={node.name}
			tabIndex={-1}
			title={title || undefined}
			style={{ paddingLeft: 4 + depth * INDENT_STEP }}
			className="focus-row flex h-6 items-center gap-1 pr-2 hover:bg-accent transition-colors"
		>
			{node.expandable ? (
				<button
					type="button"
					data-tree-toggle
					tabIndex={-1}
					aria-hidden="true"
					onClick={onToggle}
					className="shrink-0 self-stretch flex items-center text-muted-foreground"
				>
					{expanded ? (
						<ChevronDown className="w-3 h-3" />
					) : (
						<ChevronRight className="w-3 h-3" />
					)}
				</button>
			) : (
				<span className="w-3 shrink-0" />
			)}

			<button
				type="button"
				data-tree-activate
				tabIndex={-1}
				onClick={onInsert}
				className="flex min-w-0 self-stretch items-center gap-1 flex-1 text-left text-[11px] font-mono"
			>
				<span
					className={cn(
						"shrink-0",
						deprecated && "line-through",
						node.kind === "type" || node.kind === "branch"
							? "text-foreground"
							: "text-primary"
					)}
				>
					{node.name}
				</span>
				{node.signature && (
					<span className="truncate text-muted-foreground">{node.signature}</span>
				)}
				{node.description && (
					<span className="truncate text-muted-foreground font-sans">
						- {node.description}
					</span>
				)}
			</button>
		</div>
	);
}

export default SchemaExplorer;
