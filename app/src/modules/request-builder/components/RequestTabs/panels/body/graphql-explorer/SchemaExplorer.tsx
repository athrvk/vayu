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
 * **This header carries only what belongs to the pane** - the search box and the
 * descriptions show/hide. Status, Refresh and the control that opens and closes
 * the pane are the subject's, not the pane's, and they sit in one fixed place in
 * the Query header whether this pane is open or shut (#1224). They lived here
 * for a while because a visible Refresh in each corner doing the same thing, and
 * the schema's state described twice in two vocabularies, was the split #455 was
 * filed about; moving them to a home that does not depend on this pane's state
 * keeps that fixed without the layout changing shape as the pane opens.
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ChevronDown, ChevronRight, ListTree, Search, Text } from "lucide-react";
import { Input, TooltipIconButton, EYEBROW_CLASS } from "@/components/ui";
import { Callout } from "@/components/shared/Callout";
import { useGrowingWindow } from "@/hooks/useGrowingWindow";
import { useRovingTreeFocus } from "@/modules/collections/useRovingTreeFocus";
import { useExplorerStore } from "@/lib/graphql/explorer-store";
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
interface NodeRowModel {
	kind: "row";
	key: string;
	node: SchemaTreeNode;
	depth: number;
	matchStart: number;
	descriptionStart: number;
	/**
	 * Whether the *description* is why this row is in the results - not merely
	 * whether it also contains the term. Only that earns the whole paragraph.
	 */
	descriptionMatched: boolean;
	/**
	 * Whether the row has to name its owner. In the tree the owner is the row
	 * above it; in a flat result list it is the only thing telling
	 * `App.accessScopes` from `AppInstallation.accessScopes`.
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
 * Search matches as rows, under the headings the tree uses.
 *
 * Flattened rather than nested inside a `role="group"` per branch: the roving
 * treeview walks the DOM to decide what is a parent of what, and a wrapper
 * holding several rows would make the first of them read as the parent of the
 * rest. The headings are `presentation`, so the tree still contains only
 * treeitems, and the disambiguation a screen reader needs rides on the row
 * itself as its owner prefix rather than on a heading it would have to
 * remember.
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
	/**
	 * Insert this row into the query document. The explorer does not know what
	 * the document is; it knows which row was activated.
	 */
	onInsert: (node: SchemaTreeNode) => void;
	/**
	 * What the last activation could not do, in words, or null.
	 *
	 * The pane is where the click happened, so it is where the answer belongs.
	 * The live region says the same thing to a screen reader; for everyone else
	 * a refusal that only reaches `sr-only` text is a click that did nothing.
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
	 * Showing a search result where it lives.
	 *
	 * Two steps that cannot be one: the store opens the path and clears the
	 * search, and only the render *after* that has a row to focus. A counter
	 * rather than the id in state, because the id is not drawn from - keeping it
	 * in a ref is one render per reveal instead of two, and the effect that
	 * consumes it clears it so a later re-render cannot replay a jump the user
	 * has since scrolled away from.
	 */
	const revealTarget = useRef<string | null>(null);
	const [revealSeq, setRevealSeq] = useState(0);
	/**
	 * How far the window must stay open for a revealed row to exist.
	 *
	 * The growing window is what would otherwise swallow this: `visible` resets
	 * to one step whenever the row count changes, and going from results to tree
	 * changes it - so on a schema with more types than a step, the target is
	 * expanded in the store and never rendered, and Reveal becomes the click
	 * that does nothing all over again. Where it lands is knowable before the
	 * render, so hold the window open at least that far.
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
		/*
		 * Read the attribute rather than building a selector: a row id holds
		 * `:`, `.` and `/`, all of which mean something to a selector parser.
		 */
		const rendered = treeRef.current?.querySelectorAll<HTMLElement>("[data-tree-id]") ?? [];
		const row = Array.from(rendered).find((el) => el.getAttribute("data-tree-id") === id);
		// Absent only when the schema changed under the reveal; `revealFloor`
		// holds the window open far enough for every row the tree can show.
		if (!row) return;
		row.scrollIntoView({ block: "center" });
		row.focus();
	}, [revealSeq]);

	const { visible, sentinelRef } = useGrowingWindow(rows.length, ROW_WINDOW);
	/** The window, never smaller than a reveal needs it to be. */
	const shown = Math.max(visible, revealFloor);

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
			 * One row, since only the two pane-local controls are left. It was two
			 * while the header also carried the status badge, Refresh and the close:
			 * five affordances in a pane as narrow as 18% of the editor area left
			 * the search box - the one control that wants width - competing with the
			 * status text for it. Those three moved to the Query header (#1224), so
			 * the search box has the row to itself again.
			 */}
			<div className="flex items-center gap-1 px-2 py-1 border-b border-border shrink-0">
				<div className="relative flex-1 min-w-0">
					<Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
					<Input
						ref={searchRef}
						value={search}
						onChange={(e) => {
							// A new list is a new window; the last reveal's floor
							// describes rows this one does not have.
							setRevealFloor(0);
							setSearch(schemaKey, e.target.value);
						}}
						placeholder="Search schema"
						aria-label="Search schema"
						className="h-6 pl-6 text-[11px]"
					/>
				</div>
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

			{/*
			 * What the last click could not do, where the click happened. The
			 * shared notice primitive rather than a second copy of the stale-schema
			 * strip above: one treatment for the whole app, and one place its
			 * contrast is tuned.
			 */}
			{notice && (
				<div className="px-2 py-1.5 shrink-0" data-testid="explorer-notice">
					<Callout severity="info">{notice}</Callout>
				</div>
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
						{rows.slice(0, shown).map((row) =>
							row.kind === "group" ? (
								<p
									key={row.key}
									role="presentation"
									data-tree-group={row.label}
									className={cn(EYEBROW_CLASS, "px-2 pt-2 pb-0.5 m-0")}
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
 * The row's full signature, the way a schema declares it: `users(first: Int):
 * [User]`. Null for a row that has none.
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
	 * A branch, a "Returned by" heading and an "Arguments" heading hold rows;
	 * they write nothing. Their activator opens them, so that pressing Enter on
	 * one does what its chevron does rather than nothing at all.
	 */
	const container =
		node.kind === "branch" || node.kind === "returned-by" || node.kind === "arguments";

	/*
	 * What follows the name: the result type alone for a field that takes
	 * arguments, the whole signature for every row that has no argument list to
	 * lose. An argument list is unbounded - three arguments is ordinary - and
	 * drawn inline it took the width the result type needed, so a row read
	 * `users (first: Int, userId: In…` and never said what it answered with.
	 *
	 * The count replaces it rather than the names, which are as unbounded as the
	 * list they came from. The names are one row down, under Arguments, and the
	 * whole signature is on the hover.
	 */
	const secondary = node.args.length > 0 ? `: ${node.returnType}` : node.signature;

	/*
	 * A description the term matched is always shown in full, whatever the
	 * toggle says. Clipped to one line it is usually cut off *before* the word
	 * that put the row in the results, which leaves the user a row they cannot
	 * connect to what they typed - the failure the mark exists to prevent, and
	 * the reason a description tier needs this and the name tier does not.
	 *
	 * It asks whether the description is *why* the row matched, not whether it
	 * happens to contain the term: `Query.search` is named `search` and
	 * described "Search across users and posts.", and the looser test drew every
	 * such row's whole paragraph over the results the user was reading.
	 */
	const full = showDescription || descriptionMatched;
	const title = [
		/*
		 * The signature leads, because it is the one thing on the row that the
		 * row itself does not show whole: the arguments come off the line so the
		 * result type survives the pane's width, and this is where they stayed
		 * readable without dragging the splitter. A type row's "signature" is its
		 * kind label, which the row already draws, so it adds nothing here.
		 */
		node.kind === "type" ? null : signatureLine(node),
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
			/*
			 * Only a row that can actually open says it can. A search result is
			 * derived from the index and has no children to show, so claiming
			 * `aria-expanded` there both lies to a screen reader and hands the
			 * treeview's Right arrow a toggle that changes nothing on screen.
			 */
			aria-expanded={node.expandable && !reveal ? expanded : undefined}
			aria-level={depth + 1}
			data-tree-label={node.name}
			data-tree-id={node.id}
			tabIndex={-1}
			title={title || undefined}
			style={{ paddingLeft: 4 + depth * INDENT_STEP }}
			className="focus-row flex min-h-6 items-center gap-1 pr-2 hover:bg-accent transition-colors"
		>
			{reveal ? (
				/*
				 * In the results, the leading control goes to the tree rather
				 * than expanding in place. It takes the row-actions slot the
				 * roving treeview already reaches (Shift+Enter, Menu, Shift+F10),
				 * so it is not a mouse-only affordance the way a second tab stop
				 * inside a single-tab-stop tree would be.
				 */
				<button
					type="button"
					data-tree-menu
					tabIndex={-1}
					aria-label={`Show ${node.name} in the tree`}
					onClick={() => onReveal(reveal)}
					className="shrink-0 self-stretch flex items-center text-muted-foreground"
				>
					<ListTree className="w-3 h-3" />
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
				onClick={container ? onToggle : onInsert}
				className={cn(
					"flex min-w-0 self-stretch flex-1 text-left text-[11px] font-mono",
					full ? "flex-col justify-center py-0.5" : "items-center gap-1"
				)}
			>
				<span
					className={cn("flex min-w-0 max-w-full items-center gap-1", full && "w-full")}
				>
					{/*
					 * The owner rides *beside* the name rather than inside it: the
					 * name is what the search marked and what a screen reader
					 * reads as the row's subject, and folding the owner into it
					 * would move both. No gap between the two, because
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
					</span>
					{node.args.length > 0 && (
						<span data-tree-args className="shrink-0 text-muted-foreground">
							({node.args.length} {node.args.length === 1 ? "arg" : "args"})
						</span>
					)}
					{secondary && (
						<span data-tree-signature className="truncate text-muted-foreground">
							{secondary}
						</span>
					)}
					{node.description && !full && (
						/*
						 * `flex-1` is a basis of zero, so a clipped description
						 * takes the width left over rather than competing for it:
						 * the result type keeps its own, and a documented field is
						 * not a field whose type is cut off. It still clips, which
						 * is what the pane's show-descriptions toggle is for.
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
