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
 * **Every schema affordance lives in this header.** Status, freshness, refresh,
 * search and the control that closes the pane again - one subject, one place.
 * Three of them were here already and the other two sat in the Query pane's
 * header, which meant a visible Refresh in each corner doing the same thing and
 * the schema's state described twice in two vocabularies (#455). The Query
 * header now carries one chip, and only while this pane is closed.
 *
 * **It adds no introspection of its own.** The pane renders whatever the schema
 * cache is holding. #382 made the body-tab lifecycle the whole consent budget
 * for talking to the endpoint, and a pane that fetched on open would quietly
 * widen it.
 *
 * Search, expansion and scroll live in `explorer-store`, not in this component:
 * Radix unmounts the whole Body tab whenever the user glances at Headers, and
 * state here would not survive it.
 */

import { useCallback, useMemo, useRef } from "react";
import {
	AlertCircle,
	ChevronDown,
	ChevronRight,
	Loader2,
	PanelRightClose,
	RefreshCw,
	Search,
	Text,
} from "lucide-react";
import { Input, TooltipIconButton, EYEBROW_CLASS } from "@/components/ui";
import { useGrowingWindow } from "@/hooks/useGrowingWindow";
import { useRovingTreeFocus } from "@/modules/collections/useRovingTreeFocus";
import { useExplorerStore } from "@/lib/graphql/explorer-store";
import {
	buildSearchIndex,
	searchSchema,
	splitAtMatch,
	visibleRows,
	type SchemaTreeNode,
} from "@/lib/graphql/schema-tree";
import type { SchemaEntry } from "@/lib/graphql/schema-cache";
import { SchemaStatusBadge } from "../SchemaStatusBadge";
import { formatRelativeTime } from "@/utils/helpers";
import { cn } from "@/lib/utils";

/** How many rows to render before the window grows. */
const ROW_WINDOW = 200;
/** One level of indentation, in pixels. Matches the collection tree's step. */
const INDENT_STEP = 12;

/**
 * A row on screen: a node, how deep it sits, and where the search term matched
 * it.
 *
 * Tree rows carry -1 for both, the same "no match" the search itself reports -
 * so a row draws its name and its description whole without needing to know
 * which of the two modes produced it.
 */
interface ExplorerRowModel {
	node: SchemaTreeNode;
	depth: number;
	matchStart: number;
	descriptionStart: number;
}

export interface SchemaExplorerProps {
	/**
	 * The cache's own snapshot - status, schema, failure and freshness together.
	 *
	 * One object rather than four props for the reason `GraphQLBody` reads it as
	 * one: they are four faces of a single state, and passed separately they can
	 * be rendered a render apart from each other. It is also what the status
	 * badge takes, so this header hands it straight on.
	 */
	entry: SchemaEntry | null;
	/** The schema's cache identity - what the view state is remembered under. */
	schemaKey: string;
	onRefresh: () => void;
	/** Close the pane. The only control that does; the Query header has none. */
	onClose: () => void;
	/**
	 * Insert this row into the query document. The explorer does not know what
	 * the document is; it knows which row was activated.
	 */
	onInsert: (node: SchemaTreeNode) => void;
}

export function SchemaExplorer({
	entry,
	schemaKey,
	onRefresh,
	onClose,
	onInsert,
}: SchemaExplorerProps) {
	const schema = entry?.schema ?? null;
	const status = entry?.status ?? "idle";
	const fetchedAt = entry?.fetchedAt ?? null;

	const view = useExplorerStore((s) => s.byKey[schemaKey]);
	const search = view?.search ?? "";
	const showDescriptions = view?.showDescriptions ?? false;
	const setSearch = useExplorerStore((s) => s.setSearch);
	const toggleExpanded = useExplorerStore((s) => s.toggleExpanded);
	const setScrollTop = useExplorerStore((s) => s.setScrollTop);
	const toggleDescriptions = useExplorerStore((s) => s.toggleDescriptions);

	const treeRef = useRef<HTMLDivElement | null>(null);
	const searchRef = useRef<HTMLInputElement | null>(null);
	const roving = useRovingTreeFocus(treeRef);

	const expanded = useMemo(() => new Set(view?.expanded ?? []), [view?.expanded]);

	/*
	 * Built once per schema, not once per keystroke. It is a full pass over the
	 * type map, which is cheap for the fixture and is a hitch per character on
	 * the schema size this pane was designed for.
	 */
	const searchIndex = useMemo(() => (schema ? buildSearchIndex(schema) : null), [schema]);

	/*
	 * The term drives the rows *and* the highlight, so it is trimmed once here
	 * rather than in each place: the offsets `searchSchema` reports are into a
	 * name matched against the trimmed needle, and slicing with an untrimmed
	 * length would run the highlight past the end of the match.
	 */
	const term = search.trim();

	const rows = useMemo<ExplorerRowModel[]>(() => {
		if (!schema) return [];
		if (term && searchIndex) {
			return searchSchema(searchIndex, term).map((m) => ({
				node: m.node,
				depth: 0,
				matchStart: m.matchStart,
				descriptionStart: m.descriptionStart,
			}));
		}
		return visibleRows(schema, expanded).map((row) => ({
			...row,
			matchStart: -1,
			descriptionStart: -1,
		}));
	}, [schema, searchIndex, term, expanded]);

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
			{/*
			 * Two rows rather than one. Five affordances now live here and the
			 * pane is as narrow as 18% of the editor area; sharing a single row
			 * left the search box - the one control that wants width - competing
			 * with the status text for it.
			 */}
			<div className="flex items-center gap-1 px-2 h-7 border-b border-border shrink-0">
				<span className="flex-1 min-w-0 truncate">
					<SchemaStatusBadge entry={entry} />
				</span>
				{/*
				 * Descriptions are clipped to one line by default and the full
				 * text is only in the row's native tooltip, which is no use to
				 * anyone reading rather than pointing. This is the show/hide for
				 * it - one pane-level control rather than a per-row disclosure,
				 * because a third target inside a 24px row is exactly the
				 * composite-row hit-area trap `drawer-row-hit-area` was written
				 * against, and it would take its width from the activator.
				 */}
				<TooltipIconButton
					label={showDescriptions ? "Hide full descriptions" : "Show full descriptions"}
					aria-pressed={showDescriptions}
					className={cn("h-6 w-6 shrink-0", showDescriptions && "text-primary")}
					icon={<Text className="w-3 h-3" />}
					onClick={() => toggleDescriptions(schemaKey)}
				/>
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
				<TooltipIconButton
					label="Hide schema"
					className="h-6 w-6 shrink-0"
					icon={<PanelRightClose className="w-3 h-3" />}
					onClick={onClose}
				/>
			</div>

			<div className="flex items-center px-2 py-1 border-b border-border shrink-0">
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
						Nothing matches "{term}".
					</p>
				) : (
					// eslint-disable-next-line jsx-a11y/interactive-supports-focus -- roving tabindex - the tree is never a tab stop, useRovingTreeFocus.ts:118-123 seeds one row's `tabIndex={0}` and moves it
					<div
						ref={treeRef}
						role="tree"
						aria-label="Schema"
						onKeyDown={onKeyDown}
						onFocus={roving.onFocus}
					>
						{rows
							.slice(0, visible)
							.map(({ node, depth, matchStart, descriptionStart }) => (
								<ExplorerRow
									key={node.id}
									node={node}
									depth={depth}
									matchStart={matchStart}
									descriptionStart={descriptionStart}
									matchLength={term.length}
									showDescription={showDescriptions}
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
	/** Where the search term matched `node.name`; -1 when nothing marks the name. */
	matchStart: number;
	/** Where the search term matched `node.description`; -1 when nothing marks it. */
	descriptionStart: number;
	/** Length of the search term, i.e. how much of the text the match covers. */
	matchLength: number;
	/** Whether the pane is showing full descriptions rather than one clipped line. */
	showDescription: boolean;
	expanded: boolean;
	onToggle: () => void;
	onInsert: () => void;
}

function ExplorerRow({
	node,
	depth,
	matchStart,
	descriptionStart,
	matchLength,
	showDescription,
	expanded,
	onToggle,
	onInsert,
}: ExplorerRowProps) {
	const deprecated = node.deprecationReason !== null;
	const name = splitAtMatch(node.name, matchStart, matchLength);
	const description = splitAtMatch(node.description ?? "", descriptionStart, matchLength);

	/*
	 * A description the term matched is always shown in full, whatever the
	 * toggle says. Clipped to one line it is usually cut off *before* the word
	 * that put the row in the results, which leaves the user a row they cannot
	 * connect to what they typed - the failure the mark exists to prevent, and
	 * the reason a description tier needs this and the name tier does not.
	 */
	const full = showDescription || descriptionStart >= 0;
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
			// eslint-disable-next-line jsx-a11y/role-has-required-aria-props -- this tree has no selection model - a row inserts into the query and nothing stays selected - so `aria-selected` is omitted rather than faked
			role="treeitem"
			aria-expanded={node.expandable ? expanded : undefined}
			aria-level={depth + 1}
			data-tree-label={node.name}
			tabIndex={-1}
			title={title || undefined}
			style={{ paddingLeft: 4 + depth * INDENT_STEP }}
			className="focus-row flex min-h-6 items-center gap-1 pr-2 hover:bg-accent transition-colors"
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

			{/*
			 * One line or two, the activator stays a single button: the whole row
			 * inserts, including the description, and splitting the description
			 * onto its own control would carve a hole in the hit area the row
			 * paints - the composite-row trap again.
			 */}
			<button
				type="button"
				data-tree-activate
				tabIndex={-1}
				onClick={onInsert}
				className={cn(
					"flex min-w-0 self-stretch flex-1 text-left text-[11px] font-mono",
					full ? "flex-col justify-center py-0.5" : "items-center gap-1"
				)}
			>
				<span
					className={cn("flex min-w-0 max-w-full items-center gap-1", full && "w-full")}
				>
					<span
						data-tree-name
						className={cn(
							"shrink-0",
							deprecated && "line-through",
							node.kind === "type" || node.kind === "branch"
								? "text-foreground"
								: "text-primary"
						)}
					>
						{/*
						 * Three segments rather than one string, so the matched run
						 * can be marked without the row's own colour moving: a field
						 * name is `text-primary` and a type name `text-foreground`,
						 * and `text-inherit` keeps that distinction through the tint.
						 * The `mark` element needs both properties set - a bare one
						 * arrives with the user agent's yellow-on-black.
						 *
						 * The three concatenate to exactly `node.name`, which is what
						 * keeps the accessible row text unchanged by highlighting.
						 */}
						{name.before}
						{name.match && (
							<mark className="rounded-sm bg-primary/20 text-inherit">
								{name.match}
							</mark>
						)}
						{name.after}
					</span>
					{node.signature && (
						<span className="truncate text-muted-foreground">{node.signature}</span>
					)}
					{node.description && !full && (
						<span
							data-tree-description
							className="truncate text-muted-foreground font-sans"
						>
							- {node.description}
						</span>
					)}
				</span>

				{node.description && full && (
					<span
						data-tree-description
						className="w-full whitespace-normal break-words text-muted-foreground font-sans"
					>
						{description.before}
						{description.match && (
							<mark className="rounded-sm bg-primary/20 text-inherit">
								{description.match}
							</mark>
						)}
						{description.after}
					</span>
				)}
			</button>
		</div>
	);
}

export default SchemaExplorer;
