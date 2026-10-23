/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import {
	memo,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type Ref,
} from "react";
import CollectionItem from "./CollectionItem";
import RequestItem from "./RequestItem";
import NewFolderForm from "./NewFolderForm";
import { treeGuideStyle } from "./tree-guide-style";
import { useCollectionTreeState } from "./context/CollectionTreeContext";
import {
	folderRowKey,
	newFolderFormRowKey,
	rowHeightUnits,
	rowKeysUnder,
	rowsAroundFocus,
	rowSpacingAbove,
	rowStrides,
	type TreeRow,
} from "./tree-rows";
import { TREE_ITEM } from "./tree-focus";
import { useDraggingRowKey } from "./tree-row-dnd";
import { useTreeWindow } from "./useTreeWindow";
import { cn } from "@/lib/utils";
import { rowInsetPx } from "@/constants/layout";

/** `rowSpacingAbove`'s units as classes, written out whole for Tailwind's scan. */
const SPACING_ABOVE_CLASS = { 0: "", 0.5: "mt-0.5", 1: "mt-1" } as const;
/** `rowHeightUnits` as classes, for the same reason. */
const HEIGHT_CLASS = { 8: "h-8", 10: "h-10" } as const;

/** The attribute naming the row a wrapper holds; the wrapper spells it out literally. */
const ROW_KEY = "data-tree-row-key";

const NO_ROWS = new Set<string>();

/**
 * What the tree reaches the window through: the one way to act on a row that
 * may not be mounted (#2543). Keyboard focus, the selection reveal and the
 * moved-row reveal all go through `revealRow`, so none of them can act on a row
 * that is scrolled away.
 */
export interface TreeRowWindow {
	/**
	 * Scroll the drawer to the row `key` names, mounting it if it is not, and
	 * hand its treeitem to `then`: at once when it is mounted already, after the
	 * commit that mounts it otherwise. `false` when no visible row has the key.
	 */
	revealRow: (key: string, then?: (row: HTMLElement) => void) => boolean;
	/** The key of the row an element belongs to, `null` outside any row. */
	keyOf: (element: Element) => string | null;
	/**
	 * The row of the list an element belongs to, `null` outside any row: how
	 * the tree's one right-click menu and its drag handlers learn which row an
	 * event came from, from the model rather than from the element.
	 */
	rowOf: (element: Element) => TreeRow | null;
}

function RowContent({ row }: { row: TreeRow }) {
	switch (row.kind) {
		case "folder":
			return (
				<CollectionItem
					collection={row.collection}
					depth={row.depth}
					posInSet={row.posInSet}
					setSize={row.setSize}
					emptyPlaceholderId={row.emptyPlaceholderId}
					activeGuideLevel={row.activeGuideLevel}
				/>
			);
		case "request":
			return (
				<RequestItem
					request={row.request}
					collectionId={row.parentId}
					depth={row.depth}
					posInSet={row.posInSet}
					setSize={row.setSize}
					activeGuideLevel={row.activeGuideLevel}
				/>
			);
		case "new-folder-form":
			return (
				<NewFolderForm
					parentId={row.parentId}
					depth={row.depth}
					activeGuideLevel={row.activeGuideLevel}
				/>
			);
		case "empty-placeholder":
			// No role: it is not a treeitem, and the folder row above names it
			// through `aria-describedby` instead.
			return (
				<div
					id={row.id}
					className="flex h-full items-center pr-3 text-xs text-muted-foreground"
					style={{
						paddingLeft: rowInsetPx(row.depth),
						...treeGuideStyle(row.depth, row.activeGuideLevel),
					}}
				>
					Empty collection
				</div>
			);
	}
}

interface PendingReveal {
	key: string;
	then?: (row: HTMLElement) => void;
	/** Whether the drawer has been scrolled to the row yet. */
	scrolled: boolean;
}

function rowElement(list: HTMLElement | null, key: string): HTMLElement | null {
	const wrapper = list?.querySelector<HTMLElement>(`[${ROW_KEY}="${CSS.escape(key)}"]`);
	return wrapper?.querySelector<HTMLElement>(TREE_ITEM) ?? wrapper ?? null;
}

/**
 * The key of the row holding the tree's tab stop: the last treeitem focus
 * landed in. A focus in the new-folder form is not one - the stop stays where
 * it was, as `useRovingTreeFocus` keeps it.
 */
function useTabStopKey(list: HTMLElement | null): string | null {
	const [key, setKey] = useState<string | null>(null);
	useEffect(() => {
		if (!list) return;
		const onFocusIn = (event: FocusEvent) => {
			if (!(event.target instanceof Element)) return;
			const row = event.target.closest(TREE_ITEM)?.closest(`[${ROW_KEY}]`);
			const next = row?.getAttribute(ROW_KEY);
			if (next) setKey(next);
		};
		list.addEventListener("focusin", onFocusIn);
		return () => list.removeEventListener("focusin", onFocusIn);
	}, [list]);
	return key;
}

/**
 * The keys of the rows that stay mounted wherever the drawer is scrolled to,
 * because something holds them that a scroll must not take away.
 */
function usePinnedKeys(
	rows: readonly TreeRow[],
	keyIndex: ReadonlyMap<string, number>,
	list: HTMLElement | null,
	revealKey: string | null
): string[] {
	const { creatingSubfolder } = useCollectionTreeState();
	const draggingKey = useDraggingRowKey();
	const tabStopKey = useTabStopKey(list);

	// The tab stop and the rows focus can step to from it. A row being renamed
	// needs no pin of its own: its field holds focus for as long as the rename
	// lasts (a blur commits it), so it is the tab stop's row.
	const stopIndex = tabStopKey === null ? undefined : keyIndex.get(tabStopKey);
	const aroundStop = useMemo(
		() =>
			stopIndex === undefined
				? null
				: rowsAroundFocus(rows, stopIndex).map((index) => rows[index].key),
		[rows, stopIndex]
	);
	// Kept past the stop's own row: when a delete removes it, the row focus is
	// handed to next is one of these, and it has to still be mounted when the
	// refocus runs, a commit after the removal.
	const [lastAroundStop, setLastAroundStop] = useState<readonly string[]>([]);
	if (aroundStop && aroundStop !== lastAroundStop) setLastAroundStop(aroundStop);
	// With no stop of its own the tree seeds the first treeitem, so that one
	// holds it.
	const firstItem = rows.find((row) => row.kind === "folder" || row.kind === "request");

	return useMemo(() => {
		const keys = aroundStop ? [...aroundStop] : [...lastAroundStop];
		if (!aroundStop && firstItem) keys.push(firstItem.key);
		if (creatingSubfolder) {
			keys.push(newFolderFormRowKey(creatingSubfolder), folderRowKey(creatingSubfolder));
		}
		if (draggingKey) keys.push(draggingKey);
		if (revealKey) keys.push(revealKey);
		return keys;
	}, [aroundStop, lastAroundStop, firstItem, creatingSubfolder, draggingKey, revealKey]);
}

interface CollectionTreeRowsProps {
	rows: readonly TreeRow[];
	/**
	 * The `role="tree"` element the rows render into, which the window measures
	 * from. Until it is known, the first rows mount and nothing else.
	 */
	list?: HTMLElement | null;
	windowRef?: Ref<TreeRowWindow>;
}

/**
 * The tree's rows, one flat list in the order `flattenVisibleRows` gives them,
 * mounted only where the drawer can show them (`useTreeWindow`).
 *
 * Each row sits in a wrapper that owns the gap above it, its height, and the
 * dimming of everything inside a folder being deleted. Memoised so a keystroke in the new-folder
 * field, which re-renders the tree, does not walk the list: `rows` changes only
 * when what is visible does.
 */
function CollectionTreeRowList({ rows, list = null, windowRef }: CollectionTreeRowsProps) {
	const { deletingCollectionId } = useCollectionTreeState();
	const dimmed = useMemo(
		() => (deletingCollectionId ? rowKeysUnder(rows, deletingCollectionId) : NO_ROWS),
		[rows, deletingCollectionId]
	);

	const keyIndex = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows]);
	const strides = useMemo(() => rowStrides(rows), [rows]);

	// The row a reveal is bringing in, pinned until the next reveal replaces it,
	// and what is still to be done for it.
	const [revealKey, setRevealKey] = useState<string | null>(null);
	const pendingReveal = useRef<PendingReveal | null>(null);

	const pinnedKeys = usePinnedKeys(rows, keyIndex, list, revealKey);
	const pinned = useMemo(
		() => pinnedKeys.flatMap((key) => keyIndex.get(key) ?? []),
		[pinnedKeys, keyIndex]
	);
	const { segments, scrollToRow } = useTreeWindow(list, strides, pinned);

	const revealRow = useCallback(
		(key: string, then?: (row: HTMLElement) => void) => {
			const index = keyIndex.get(key);
			if (index === undefined) return false;
			const mounted = rowElement(list, key);
			// Before the list element is known there is nothing to scroll; the
			// commit that brings it in does the scroll instead.
			if (list) scrollToRow(index, mounted);
			if (mounted && list) {
				pendingReveal.current = null;
				then?.(mounted);
				return true;
			}
			pendingReveal.current = { key, then, scrolled: list !== null };
			setRevealKey(key);
			return true;
		},
		[keyIndex, list, scrollToRow]
	);

	const keyOf = useCallback(
		(element: Element) => element.closest(`[${ROW_KEY}]`)?.getAttribute(ROW_KEY) ?? null,
		[]
	);

	const rowOf = useCallback(
		(element: Element) => {
			const key = keyOf(element);
			const index = key === null ? undefined : keyIndex.get(key);
			return index === undefined ? null : rows[index];
		},
		[keyOf, keyIndex, rows]
	);

	useImperativeHandle(windowRef, () => ({ revealRow, keyOf, rowOf }), [revealRow, keyOf, rowOf]);

	// No dependency list: a reveal waits for the commit that brings in the list,
	// then the one that mounts its row, and nothing but the DOM says which.
	useLayoutEffect(() => {
		const pending = pendingReveal.current;
		if (!pending || !list) return;
		const index = keyIndex.get(pending.key);
		// Its row left the list before it mounted: nothing to reveal any more.
		if (index === undefined) {
			pendingReveal.current = null;
			return;
		}
		const row = rowElement(list, pending.key);
		if (!pending.scrolled) {
			pending.scrolled = true;
			scrollToRow(index, row);
		}
		if (!row) return;
		pendingReveal.current = null;
		pending.then?.(row);
	});

	return segments.flatMap((segment) => {
		if (segment.kind === "gap") {
			const units = rowsHeight(strides, segment.start, segment.end);
			// No role and hidden: it stands for rows, it is not one.
			return (
				<div
					key={`gap:${segment.start}`}
					aria-hidden="true"
					data-tree-spacer
					style={{ height: `calc(var(--spacing) * ${units})` }}
				/>
			);
		}
		// One flat array of keyed rows, never an array per run: a nested array is
		// keyed by its position, so a gap opening above a run would remount every
		// row in it - focus, rename field and pointer capture included.
		return rows.slice(segment.start, segment.end).map((row, offset) => {
			const index = segment.start + offset;
			return (
				<div
					key={row.key}
					data-tree-row-key={row.key}
					className={cn(
						SPACING_ABOVE_CLASS[rowSpacingAbove(rows, index)],
						HEIGHT_CLASS[rowHeightUnits(row)],
						dimmed.has(row.key) && "opacity-50"
					)}
				>
					<RowContent row={row} />
				</div>
			);
		});
	});
}

function rowsHeight(strides: readonly number[], start: number, end: number): number {
	let units = 0;
	for (let index = start; index < end; index++) units += strides[index];
	return units;
}

const CollectionTreeRows = memo(CollectionTreeRowList);
export default CollectionTreeRows;
