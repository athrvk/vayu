/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The schema explorer: the endpoint's own documentation, beside the editor that needs it.
 *
 * - **Beside the editor, not in the context bar.** The bar clamps to 220-480px (`layout-store`),
 *   which is where Postman's explorer lives and why it reads as a cramped list, and insertion wants
 *   to sit by the cursor. The bar gets the *status* half (freshness, an outline): glanceable,
 *   unlike browsing.
 * - **This header carries only the pane's own controls**: search and the descriptions toggle.
 *   Status, Refresh and the pane's open control belong to the subject and sit in one fixed place in
 *   the Query header, open or shut (#1224), so the schema's state is not described twice and the
 *   layout does not change shape as the pane opens (#455).
 * - **No introspection of its own.** The pane renders what the schema cache holds: #382 made the
 *   body-tab lifecycle the whole consent budget for contacting the endpoint, and fetching on open
 *   would widen it.
 *
 * Search, expansion and scroll live in `explorer-store`: Radix unmounts the Body tab on every
 * glance at Headers, and state here would not survive.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ChevronDown, ChevronRight, ListTree, Search, Text } from "lucide-react";
import { Button, Input, TooltipIconButton, EYEBROW_CLASS } from "@/components/ui";
import { Callout } from "@/components/shared/Callout";
import { EmptyState } from "@/components/shared/EmptyState";
import { rowInsetPx } from "@/constants/layout";
import { useGrowingWindow } from "@/hooks/useGrowingWindow";
import { useRovingTreeFocus } from "@/modules/collections/useRovingTreeFocus";
import { useExplorerStore } from "@/lib/graphql/explorer-store";
import { scrollWithin } from "@/lib/scroll-within";
import {
	buildSearchIndex,
	groupSearchMatches,
	searchSchema,
	splitAtMatch,
	treeLocationOf,
	visibleRows,
	type SchemaSearchMatch,
	type SchemaTreeNode,
	type TreeLocation,
} from "@/lib/graphql/schema-tree";
import type { SchemaEntry } from "@/lib/graphql/schema-cache";
import { TimeValue } from "@/components/shared/TimeValue";
import { cn } from "@/lib/utils";
import { pluralize } from "@/modules/dashboard/utils/format";

/** How many rows to render before the window grows. */
const ROW_WINDOW = 200;

/**
 * A row on screen: its node, depth, and where the search matched it. Tree rows carry -1 for both,
 * search's own "no match", so a row draws name and description whole without knowing its mode.
 */
interface NodeRowModel {
	kind: "row";
	key: string;
	node: SchemaTreeNode;
	depth: number;
	matchStart: number;
	descriptionStart: number;
	/**
	 * Whether the *description* is why the row is in the results, not merely contains the term;
	 * only that earns the whole paragraph.
	 */
	descriptionMatched: boolean;
	/**
	 * Whether the row names its owner: in the tree the owner is the row above; in a flat result
	 * list it alone tells `App.accessScopes` from `AppInstallation.accessScopes`.
	 */
	showOwner: boolean;
	/** Where this row lives in the tree, when it can be shown there. */
	reveal: TreeLocation | null;
}

/** A heading over the results of one branch. Not a row the tree navigates. */
interface GroupRowModel {
	kind: "group";
	key: string;
	label: string;
}

type ExplorerRowModel = NodeRowModel | GroupRowModel;

/**
 * Search matches as rows, under the tree's headings. Flat, not nested in a `role="group"` per
 * branch: the roving treeview walks the DOM for parenthood, and a wrapper would make its first row
 * read as the parent of the rest. Headings are `presentation`, so the tree holds only treeitems,
 * and each row carries its owner prefix for a screen reader instead of a heading to remember.
 */
function searchRows(matches: SchemaSearchMatch[]): ExplorerRowModel[] {
	return groupSearchMatches(matches).flatMap((group) => [
		{ kind: "group" as const, key: `group:${group.branch}`, label: group.label },
		...group.matches.map((match): NodeRowModel => ({
			kind: "row",
			key: match.node.id,
			node: match.node,
			depth: 0,
			matchStart: match.matchStart,
			descriptionStart: match.descriptionStart,
			descriptionMatched: match.tier === "description",
			showOwner: match.node.ownerTypeName !== null,
			reveal: treeLocationOf(match.node),
		})),
	]);
}

export interface SchemaExplorerProps {
	/**
	 * The cache's snapshot (status, schema, failure, freshness), as one object for `GraphQLBody`'s
	 * reason: four faces of one state, which separate props could render a render apart. The status
	 * badge takes the same object, so it is handed straight on.
	 */
	entry: SchemaEntry | null;
	/** The schema's cache identity - what the view state is remembered under. */
	schemaKey: string;
	/**
	 * Insert this row into the query; the explorer knows which row was activated, not the document.
	 */
	onInsert: (node: SchemaTreeNode) => void;
	/**
	 * What the last activation could not do, or null. Shown in the pane, where the click happened;
	 * the live region tells a screen reader, but for everyone else an `sr-only` refusal is a dead
	 * click.
	 */
	notice?: string | null;
}

export function SchemaExplorer({ entry, schemaKey, onInsert, notice = null }: SchemaExplorerProps) {
	const schema = entry?.schema ?? null;
	const status = entry?.status ?? "idle";
	const fetchedAt = entry?.fetchedAt ?? null;

	const view = useExplorerStore((s) => s.byKey[schemaKey]);
	const search = view?.search ?? "";
	const showDescriptions = view?.showDescriptions ?? false;
	const setSearch = useExplorerStore((s) => s.setSearch);
	const toggleExpanded = useExplorerStore((s) => s.toggleExpanded);
	const revealPath = useExplorerStore((s) => s.revealPath);
	const setScrollTop = useExplorerStore((s) => s.setScrollTop);
	const toggleDescriptions = useExplorerStore((s) => s.toggleDescriptions);

	const treeRef = useRef<HTMLDivElement | null>(null);
	const searchRef = useRef<HTMLInputElement | null>(null);
	const roving = useRovingTreeFocus(treeRef);

	const expanded = useMemo(() => new Set(view?.expanded ?? []), [view?.expanded]);

	/*
	 * Built once per schema, not per keystroke: a full pass over the type map, cheap on the fixture
	 * but a hitch per character at the schema size this pane is designed for.
	 */
	const searchIndex = useMemo(() => (schema ? buildSearchIndex(schema) : null), [schema]);

	/*
	 * Trimmed once here, since it drives rows and highlight: `searchSchema`'s offsets are into a
	 * name matched against the trimmed needle, and an untrimmed length runs the highlight past the
	 * match.
	 */
	const term = search.trim();

	const rows = useMemo<ExplorerRowModel[]>(() => {
		if (!schema) return [];
		if (term && searchIndex) return searchRows(searchSchema(searchIndex, term));
		return visibleRows(schema, expanded).map((row): NodeRowModel => ({
			kind: "row",
			key: row.node.id,
			node: row.node,
			depth: row.depth,
			matchStart: -1,
			descriptionStart: -1,
			descriptionMatched: false,
			showOwner: false,
			reveal: null,
		}));
	}, [schema, searchIndex, term, expanded]);

	/*
	 * Showing a result where it lives takes two steps: the store opens the path and clears the
	 * search, and only the next render has a row to focus. A counter in state, the id in a ref (it
	 * is not drawn: one render per reveal, not two), and the consuming effect clears it so a
	 * re-render cannot replay a jump the user scrolled away from.
	 */
	const revealTarget = useRef<string | null>(null);
	const [revealSeq, setRevealSeq] = useState(0);
	/**
	 * How far the window must stay open for a revealed row to exist. `visible` resets to one step
	 * when the row count changes, and results to tree changes it, so on a schema larger than a step
	 * the target would be expanded but never rendered and Reveal would do nothing. Where it lands
	 * is known before the render, so the window holds open that far.
	 */
	const [revealFloor, setRevealFloor] = useState(0);

	const reveal = useCallback(
		(location: TreeLocation) => {
			if (!schema) return;
			const opened = new Set([...expanded, ...location.expand]);
			const index = visibleRows(schema, opened).findIndex((r) => r.node.id === location.id);
			setRevealFloor(index >= 0 ? index + 1 : 0);
			revealTarget.current = location.id;
			revealPath(schemaKey, location.expand);
			setRevealSeq((n) => n + 1);
		},
		[expanded, revealPath, schema, schemaKey]
	);

	useEffect(() => {
		const id = revealTarget.current;
		if (!id) return;
		revealTarget.current = null;
		// Read the attribute, not a selector: a row id holds `:`, `.` and `/`, which a selector
		// parses.
		const rendered = treeRef.current?.querySelectorAll<HTMLElement>("[data-tree-id]") ?? [];
		const row = Array.from(rendered).find((el) => el.getAttribute("data-tree-id") === id);
		// Absent only when the schema changed under the reveal; `revealFloor` keeps every reachable
		// row open.
		if (!row) return;
		// The pane's overflow-hidden ancestors make scrollIntoView unsafe here too (#1612): it
		// would scroll past this scroller, the tree's parent (the `ref={scrollerRef}` div).
		const scroller = treeRef.current?.parentElement;
		if (scroller) scrollWithin(scroller, row, { block: "center" });
		row.focus();
	}, [revealSeq]);

	const { visible, sentinelRef } = useGrowingWindow(rows.length, ROW_WINDOW);
	/** The window, never smaller than a reveal needs it to be. */
	const shown = Math.max(visible, revealFloor);

	/*
	 * Restore the last mount's scroll position. A callback ref, not an effect: the scroller mounts
	 * with the Body tab, and the position must be set when the node exists, before the top paints.
	 * `getState` keeps it off the subscription: the scroll handler writes every frame, and a render
	 * per tick would follow.
	 */
	const scrollerRef = useCallback(
		(node: HTMLDivElement | null) => {
			if (node) node.scrollTop = useExplorerStore.getState().view(schemaKey).scrollTop;
		},
		[schemaKey]
	);

	/*
	 * `/` focuses search, as in a document viewer, unless the user is already typing (a slash is
	 * legal in a term). The rest is the treeview pattern `useRovingTreeFocus` implements; this
	 * wraps it, so the tree keeps whatever that hook learns.
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

	return (
		<div className="flex flex-col h-full min-h-0 bg-panel" data-testid="graphql-explorer">
			{/*
			 * One row: only the two pane-local controls are left (status, Refresh and close moved
			 * to the Query header, #1224), so the search box, the one control that wants width, has
			 * the row to itself.
			 */}
			<div className="flex items-center gap-1 px-2 py-1 border-b border-border shrink-0">
				<div className="relative flex-1 min-w-0">
					<Search className="absolute left-2 top-1/2 -translate-y-1/2 size-icon-sm text-muted-foreground pointer-events-none" />
					<Input
						size="sm"
						ref={searchRef}
						value={search}
						onChange={(e) => {
							// A new list is a new window; the last reveal's floor describes rows
							// this one lacks.
							setRevealFloor(0);
							setSearch(schemaKey, e.target.value);
						}}
						placeholder="Search schema"
						aria-label="Search schema"
						className="pl-6 text-label"
					/>
				</div>
				{/*
				 * Descriptions clip to one line and the full text is only in the native tooltip, no
				 * use to a reader. One pane-level toggle, not per-row: a third target in a 24px row
				 * is the composite-row hit-area trap `drawer-row-hit-area` guards, and would take
				 * its width from the activator.
				 */}
				<TooltipIconButton
					label={showDescriptions ? "Hide full descriptions" : "Show full descriptions"}
					aria-pressed={showDescriptions}
					className={cn("size-target shrink-0", showDescriptions && "text-primary")}
					icon={<Text className="size-icon-sm" />}
					onClick={() => toggleDescriptions(schemaKey)}
				/>
			</div>

			{/*
			 * A stale schema browses, its age stated: blanking on a failed refresh would discard
			 * the only answer, as `schema-cache` keeps the last good schema.
			 */}
			{schema && status === "error" && (
				<p className="enter-fade flex items-center gap-1 px-2 py-1 m-0 text-micro text-warning-text border-b border-border shrink-0">
					<AlertCircle className="size-icon-sm shrink-0" />
					{fetchedAt ? (
						<span>
							Schema from <TimeValue value={fetchedAt} style="relative" />.
							Couldn&apos;t refresh it.
						</span>
					) : (
						"Couldn't refresh the schema."
					)}
				</p>
			)}

			{/*
			 * What the last click could not do, where the click happened, through the shared notice
			 * primitive: one treatment app-wide, one place its contrast is tuned.
			 */}
			{notice && (
				<div className="enter-fade px-2 py-1.5 shrink-0" data-testid="explorer-notice">
					<Callout severity="info">{notice}</Callout>
				</div>
			)}

			<div
				ref={scrollerRef}
				className="flex-1 min-h-0 overflow-auto"
				onScroll={(e) => setScrollTop(schemaKey, e.currentTarget.scrollTop)}
			>
				{/*
				 * The loading line and group headings take a root row's inset (`rowInsetPx(0)`,
				 * where a branch row starts), so the pane keeps one left edge loading or not
				 * (#1378, #1372). The two empty lines are `EmptyState`, centred (#3501).
				 */}
				{!schema && status === "loading" ? (
					<p
						className="pr-2 py-2 m-0 text-label text-muted-foreground"
						style={{ paddingLeft: rowInsetPx(0) }}
					>
						Loading the schema…
					</p>
				) : !schema ? (
					<EmptyState
						variant="inline"
						compact
						title="No schema loaded. Refresh to introspect the endpoint."
					/>
				) : rows.length === 0 ? (
					<EmptyState
						variant="inline"
						compact
						title={`Nothing matches "${term}".`}
						action={
							<Button
								variant="link"
								size="sm"
								onClick={() => setSearch(schemaKey, "")}
							>
								Clear the filter
							</Button>
						}
					/>
				) : (
					// eslint-disable-next-line jsx-a11y/interactive-supports-focus -- roving tabindex - the tree is never a tab stop, useRovingTreeFocus.ts:125-130 seeds one row's `tabIndex={0}` and moves it
					<div
						ref={treeRef}
						role="tree"
						aria-label="Schema"
						onKeyDown={onKeyDown}
						onFocus={roving.onFocus}
					>
						{rows.slice(0, shown).map((row) =>
							row.kind === "group" ? (
								<p
									key={row.key}
									role="presentation"
									data-tree-group={row.label}
									className={cn(EYEBROW_CLASS, "pr-2 pt-2 pb-0.5 m-0")}
									style={{ paddingLeft: rowInsetPx(0) }}
								>
									{row.label}
								</p>
							) : (
								<ExplorerRow
									key={row.key}
									node={row.node}
									depth={row.depth}
									matchStart={row.matchStart}
									descriptionStart={row.descriptionStart}
									descriptionMatched={row.descriptionMatched}
									showOwner={row.showOwner}
									reveal={row.reveal}
									matchLength={term.length}
									showDescription={showDescriptions}
									expanded={expanded.has(row.node.id)}
									onToggle={() => toggleExpanded(schemaKey, row.node.id)}
									onReveal={reveal}
									onInsert={() => onInsert(row.node)}
								/>
							)
						)}
						{shown < rows.length && (
							<div ref={sentinelRef} className="px-2 py-1">
								<span className={EYEBROW_CLASS}>
									Showing {shown} of {rows.length}
								</span>
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * The row's full signature as the schema declares it, `users(first: Int): [User]`; null without
 * one.
 */
function signatureLine(node: SchemaTreeNode): string | null {
	return node.signature ? `${node.name}${node.signature}` : null;
}

interface ExplorerRowProps {
	node: SchemaTreeNode;
	depth: number;
	/** Where the search term matched `node.name`; -1 when nothing marks the name. */
	matchStart: number;
	/** Where the search term matched `node.description`; -1 when nothing marks it. */
	descriptionStart: number;
	/** Whether the description is *why* this row matched. */
	descriptionMatched: boolean;
	/** Whether to prefix the name with the type that declares it. */
	showOwner: boolean;
	/** Where the row lives in the tree, or null when it is already there. */
	reveal: TreeLocation | null;
	/** Length of the search term, i.e. how much of the text the match covers. */
	matchLength: number;
	/** Whether the pane is showing full descriptions rather than one clipped line. */
	showDescription: boolean;
	expanded: boolean;
	onToggle: () => void;
	onReveal: (location: TreeLocation) => void;
	onInsert: () => void;
}

function ExplorerRow({
	node,
	depth,
	matchStart,
	descriptionStart,
	descriptionMatched,
	showOwner,
	reveal,
	matchLength,
	showDescription,
	expanded,
	onToggle,
	onReveal,
	onInsert,
}: ExplorerRowProps) {
	const deprecated = node.deprecationReason !== null;
	const name = splitAtMatch(node.name, matchStart, matchLength);
	const description = splitAtMatch(node.description ?? "", descriptionStart, matchLength);

	/*
	 * A branch, "Returned by" or "Arguments" heading holds rows and writes nothing; its activator
	 * opens it, so Enter does what the chevron does.
	 */
	const container =
		node.kind === "branch" || node.kind === "returned-by" || node.kind === "arguments";

	/*
	 * After the name: the result type alone for a field with arguments, the whole signature
	 * otherwise. An argument list is unbounded, and inline it took the result type's width, so a
	 * row read `users (first: Int, userId: In…` and never said what it returned. A count replaces
	 * it, not the names; they are a row down under Arguments, and the whole signature is on hover.
	 */
	const secondary = node.args.length > 0 ? `: ${node.returnType}` : node.signature;

	/*
	 * A description the term matched is shown whole, whatever the toggle: clipped, it is usually
	 * cut before the word that matched, leaving a row the user cannot connect to their term. The
	 * test is whether the description is *why* the row matched, not whether it contains the term:
	 * `Query.search` is described "Search across users and posts.", and the looser test drew every
	 * such paragraph over the results.
	 */
	const full = showDescription || descriptionMatched;
	const title = [
		/*
		 * The signature leads: it is the one thing the row does not show whole (the arguments come
		 * off the line so the result type fits), so it is readable here without the splitter. A
		 * type row's "signature" is its kind label, already drawn.
		 */
		node.kind === "type" ? null : signatureLine(node),
		node.description,
		deprecated ? `Deprecated: ${node.deprecationReason}` : null,
		node.branch === "subscription" && node.kind === "field"
			? "Subscriptions can't be run here - Vayu sends one HTTP request and reads one response."
			: null,
	]
		.filter(Boolean)
		.join("\n");

	return (
		/*
		 * The row is the perceived target and paints the hover fill; the activator inside is
		 * `self-stretch`, so fill and hit area are one rectangle. A content-height activator in an
		 * `items-center` row left the top and bottom dead, over 40% of the drawer's rows before
		 * `drawer-row-hit-area` pinned it.
		 */
		<div
			// eslint-disable-next-line jsx-a11y/role-has-required-aria-props -- this tree has no selection model - a row inserts into the query and nothing stays selected - so `aria-selected` is omitted rather than faked
			role="treeitem"
			/*
			 * Only a row that can open says so. A search result has no children to show, so
			 * `aria-expanded` there lies to a screen reader and hands Right arrow a toggle that
			 * changes nothing.
			 */
			aria-expanded={node.expandable && !reveal ? expanded : undefined}
			aria-level={depth + 1}
			data-tree-label={node.name}
			data-tree-id={node.id}
			tabIndex={-1}
			title={title || undefined}
			style={{ paddingLeft: rowInsetPx(depth) }}
			className="focus-row flex min-h-6 items-center gap-1 pr-2 hover:bg-accent transition-colors"
		>
			{reveal ? (
				/*
				 * In the results, the leading control goes to the tree instead of expanding. It
				 * takes the row-actions slot the roving treeview reaches (Shift+Enter, Menu,
				 * Shift+F10), so it is not mouse-only as a second tab stop in a single-stop tree
				 * would be.
				 */
				<button
					type="button"
					data-tree-menu
					tabIndex={-1}
					aria-label={`Show ${node.name} in the tree`}
					onClick={() => onReveal(reveal)}
					className="shrink-0 self-stretch flex items-center text-muted-foreground"
				>
					<ListTree className="size-icon-sm" />
				</button>
			) : node.expandable ? (
				<button
					type="button"
					data-tree-toggle
					tabIndex={-1}
					aria-hidden="true"
					onClick={onToggle}
					className="shrink-0 self-stretch flex items-center text-muted-foreground"
				>
					{expanded ? (
						<ChevronDown className="size-icon-sm" />
					) : (
						<ChevronRight className="size-icon-sm" />
					)}
				</button>
			) : (
				<span className="w-3 shrink-0" />
			)}

			{/*
			 * One line or two, the activator is one button: the whole row inserts, and a separate
			 * description control would carve a hole in the row's hit area (the composite-row
			 * trap).
			 */}
			<button
				type="button"
				data-tree-activate
				tabIndex={-1}
				onClick={container ? onToggle : onInsert}
				className={cn(
					"flex min-w-0 self-stretch flex-1 text-left text-label font-mono",
					full ? "flex-col justify-center py-0.5" : "items-center gap-1"
				)}
			>
				<span
					className={cn("flex min-w-0 max-w-full items-center gap-1", full && "w-full")}
				>
					{/*
					 * The owner sits *beside* the name, not in it: the name is what the search
					 * marked and what a screen reader reads as the row's subject. No gap:
					 * `App.accessScopes` is one address, not two words.
					 */}
					<span className="flex shrink-0 items-center">
						{showOwner && node.ownerTypeName && (
							<span data-tree-owner className="text-muted-foreground">
								{node.ownerTypeName}.
							</span>
						)}
						<span
							data-tree-name
							className={cn(
								deprecated && "line-through",
								node.kind === "type" || node.kind === "branch"
									? "text-foreground"
									: "text-primary"
							)}
						>
							{/*
							 * Three segments, not one string, so the match is marked without moving
							 * the row's colour: a field name is `text-primary`, a type
							 * `text-foreground`, and `text-inherit` keeps that through the tint.
							 * `mark` needs both properties set, or it arrives in the user agent's
							 * yellow-on-black. The three concatenate to `node.name`, so the
							 * accessible text is unchanged.
							 */}
							{name.before}
							{name.match && (
								<mark className="rounded-sm bg-primary-tint text-inherit">
									{name.match}
								</mark>
							)}
							{name.after}
						</span>
					</span>
					{node.args.length > 0 && (
						<span data-tree-args className="shrink-0 text-muted-foreground">
							({node.args.length} {pluralize(node.args.length, "arg")})
						</span>
					)}
					{secondary && (
						<span data-tree-signature className="truncate text-muted-foreground">
							{secondary}
						</span>
					)}
					{node.description && !full && (
						/*
						 * `flex-1` is a zero basis, so a clipped description takes leftover width:
						 * the result type keeps its own. It still clips, which the
						 * show-descriptions toggle is for.
						 */
						<span
							data-tree-description
							className="flex-1 truncate text-muted-foreground font-sans"
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
							<mark className="rounded-sm bg-primary-tint text-inherit">
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
