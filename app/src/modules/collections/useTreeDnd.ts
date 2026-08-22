/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The drag machinery behind the collection tree - phase 3 of #364.
 *
 * Everything decidable without a DOM already lives elsewhere: `drag-gesture.ts`
 * owns press-versus-drag and the trailing click, `drop-position.ts` owns the
 * zones and the folders-first block rule, `reorder-math.ts` owns which rows a
 * move rewrites, and `useReorderMutation` owns the one atomic write. What is
 * left here is the part that genuinely needs the browser: pointer capture, hit
 * testing, spring-loading, auto-scroll, and putting focus back on the row that
 * moved.
 *
 * **Pointer events, not HTML5 drag-and-drop.** Capture keeps the event stream
 * on the source row wherever the pointer goes, which is what makes auto-scroll
 * and an Escape cancel possible at all, and it leaves the click semantics the
 * hit-area rules depend on untouched below the movement threshold.
 *
 * **One move goes through one function.** A drop, an Alt+Arrow, a "Move to..."
 * and an Undo all end in `applyPlacement`, so the optimistic write, the
 * announcement, the reveal and the undo offer cannot drift between the four
 * ways a row can move.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ArrowRightLeft } from "lucide-react";
import { useReorderMutation } from "@/queries";
import { useToastStore, useSaveStore } from "@/stores";
import { useCollectionsStore } from "@/modules/collections/collections-store";
import { compareTreeOrder, type Collection, type Request } from "@/types";
import { isDescendant } from "./tree-utils";
import { isEmptyPlan, planCollectionMove, planRequestMove, type OrderedRow } from "./reorder-math";
import {
	consumeClick,
	cancelGesture,
	moveGesture,
	pressGesture,
	releaseGesture,
	IDLE_GESTURE,
	type DragGesture,
} from "./drag-gesture";
import { resolveDrop, zoneAt, type DropDestination, type TreeEntity } from "./drop-position";
import type { CollectionTreeDnd, CollectionTreeDropTarget } from "./context/CollectionTreeContext";
import { TIMING } from "@/config/timing";

/** Alt+Arrow directions, in tree terms rather than screen terms. */
export type TreeMoveDirection = "up" | "down" | "in" | "out";

/** Where a row sits, or is being put: an ordered block and an index in it. */
interface Placement {
	/** The collection owning the block, or `null` for the root collections. */
	ownerId: string | null;
	index: number;
}

export interface TreeDndOptions {
	collections: Collection[];
	getRequestsByCollection: (collectionId: string) => Request[];
	/** The tree root, for hit testing and for finding the scroll container. */
	treeRef: RefObject<HTMLElement | null>;
	/** Rows mid-rename or mid-delete are neither drag sources nor drop targets. */
	isRowBusy: (entityId: string) => boolean;
	/** Re-expand and re-focus a row after it moves - see `useRevealActiveSelection`. */
	revealEntity: (entity: TreeEntity) => void;
}

export interface TreeDnd {
	/** The slice every row reads. */
	dnd: CollectionTreeDnd;
	/** Text for the tree's live region; empty until something moves. */
	announcement: string;
	/** The row whose "Move to..." dialog is open. */
	moveTarget: TreeEntity | null;
	closeMoveDialog: () => void;
	/** Dialog choice: append the row to the end of `ownerId`'s matching block. */
	moveToOwner: (entity: TreeEntity, ownerId: string | null) => void;
}

/** Pixels from the scroll container's edge that start an auto-scroll. */
const AUTO_SCROLL_BAND_PX = 24;
/** Pixels per frame while auto-scrolling. */
const AUTO_SCROLL_STEP_PX = 8;

/** Subfolders of `parentId`, in the order the tree renders them. */
function collectionSiblings(collections: readonly Collection[], parentId: string | null) {
	return collections
		.filter((c) => (c.parentId ?? null) === parentId)
		.slice()
		.sort(compareTreeOrder);
}

/**
 * The row a DOM node stands for, or `null` if it is not a tree row.
 *
 * Read off the row's own data attributes rather than looked up by id: the hit
 * test already has the element, and a request's owning collection is not
 * derivable from the loaded collections without scanning every request list.
 */
function entityFromRow(el: Element | null): TreeEntity | null {
	if (!(el instanceof HTMLElement)) return null;
	const name = el.getAttribute("data-tree-label") ?? "";
	const requestId = el.getAttribute("data-request-id");
	if (requestId) {
		const collectionId = el.getAttribute("data-owner-id");
		return collectionId ? { kind: "request", id: requestId, name, collectionId } : null;
	}
	const collectionId = el.getAttribute("data-collection-id");
	if (!collectionId) return null;
	return {
		kind: "collection",
		id: collectionId,
		name,
		parentId: el.getAttribute("data-parent-id") || null,
	};
}

/**
 * Whether an event that reached a row's handler actually happened on that row.
 *
 * A row renders its own ⋯ menu, and Radix renders the menu's items through a
 * **portal** - a React child of the row whose DOM lives on `document.body`.
 * React bubbles synthetic events through the component tree rather than the DOM
 * tree, so pressing "Delete" arrives here as a press on the row.
 *
 * Treating it as one is not a cosmetic bug: the press captures the pointer on
 * the row, and the capture retargets the `pointerup` the menu item needed, so
 * every action in every row menu silently stops working. A DOM containment
 * check is the difference between the two, and it is the *only* difference -
 * `closest("[data-tree-menu]")` cannot see it, because portalled content is not
 * inside the trigger it belongs to.
 */
function isOwnEvent(e: { target: EventTarget | null; currentTarget: HTMLElement }): boolean {
	return e.target instanceof Node && e.currentTarget.contains(e.target);
}

/**
 * The index a destination names, in the block *without* the moved row - which
 * is the index `reorder-math` splices into. `null` when the anchor is not in
 * the block, which means the tree changed under the drag.
 */
function indexInBlock(
	siblings: readonly OrderedRow[],
	movedId: string,
	destination: DropDestination
): number | null {
	const list = siblings.filter((row) => row.id !== movedId);
	if (!destination.anchorId) return destination.placement === "before" ? 0 : list.length;
	const at = list.findIndex((row) => row.id === destination.anchorId);
	if (at < 0) return null;
	return destination.placement === "after" ? at + 1 : at;
}

export function useTreeDnd({
	collections,
	getRequestsByCollection,
	treeRef,
	isRowBusy,
	revealEntity,
}: TreeDndOptions): TreeDnd {
	const reorder = useReorderMutation();
	const expandCollection = useCollectionsStore((s) => s.expandCollection);
	const expandedCollectionIds = useCollectionsStore((s) => s.expandedCollectionIds);

	const [dragging, setDragging] = useState<TreeEntity | null>(null);
	const [dropTarget, setDropTarget] = useState<CollectionTreeDropTarget | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const [moveTarget, setMoveTarget] = useState<TreeEntity | null>(null);

	/*
	 * The gesture, the pressed row and the resolved destination are refs, not
	 * state: they change on every `pointermove`, and a render per move would
	 * rebuild every row in the tree to move a 2px line. What renders - the
	 * dragged row and the indicator - is state, and only changes when the
	 * indicator actually moves.
	 */
	const gestureRef = useRef<DragGesture>(IDLE_GESTURE);
	const pressedRef = useRef<{ entity: TreeEntity; pointerId: number; el: HTMLElement } | null>(
		null
	);
	const destinationRef = useRef<DropDestination | null>(null);
	const springRef = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
	const autoScrollRef = useRef<{ direction: number; frame: number | null }>({
		direction: 0,
		frame: null,
	});

	/*
	 * The tree data as of the last render, for the callbacks that outlive it -
	 * an Undo click happens after the move it inverts, and must plan against
	 * where things are *then*, not where they were when the toast was raised.
	 */
	const dataRef = useRef({ collections, getRequestsByCollection });
	useEffect(() => {
		dataRef.current = { collections, getRequestsByCollection };
	}, [collections, getRequestsByCollection]);

	const requestSiblings = useCallback(
		(collectionId: string) => dataRef.current.getRequestsByCollection(collectionId),
		[]
	);

	/** Where the row is now - the placement an Undo has to restore. */
	const placementOf = useCallback(
		(entity: TreeEntity): Placement => {
			if (entity.kind === "collection") {
				const siblings = collectionSiblings(dataRef.current.collections, entity.parentId);
				return {
					ownerId: entity.parentId,
					index: Math.max(
						0,
						siblings.findIndex((c) => c.id === entity.id)
					),
				};
			}
			const siblings = requestSiblings(entity.collectionId);
			return {
				ownerId: entity.collectionId,
				index: Math.max(
					0,
					siblings.findIndex((r) => r.id === entity.id)
				),
			};
		},
		[requestSiblings]
	);

	const nameOf = useCallback((ownerId: string | null): string => {
		if (!ownerId) return "the top level";
		return dataRef.current.collections.find((c) => c.id === ownerId)?.name ?? "the collection";
	}, []);

	/**
	 * The one write path. Every way a row can move - a drop, Alt+Arrow, the
	 * "Move to..." dialog, an Undo - lands here, so the batch, the announcement
	 * and the reveal are the same three steps in the same order whichever
	 * gesture started it.
	 *
	 * Returns where the row came from and what it now is, which is exactly what
	 * an Undo needs: the same call, with the two swapped.
	 */
	const writeMove = useCallback(
		(entity: TreeEntity, to: Placement): { from: Placement; moved: TreeEntity } | null => {
			const from = placementOf(entity);
			const { collections: allCollections } = dataRef.current;

			let plan;
			let blockSize: number;
			// The row as it is *after* the move, so a reveal expands the folder it
			// landed in and an Undo plans from its new scope rather than its old.
			// Built inside the branches: only there is the destination owner known
			// to be the kind of owner this row can have.
			let moved: TreeEntity;
			try {
				if (entity.kind === "collection") {
					const fromSiblings = collectionSiblings(allCollections, entity.parentId);
					const toSiblings =
						entity.parentId === to.ownerId
							? fromSiblings
							: collectionSiblings(allCollections, to.ownerId);
					blockSize =
						entity.parentId === to.ownerId ? toSiblings.length : toSiblings.length + 1;
					plan = planCollectionMove({
						movedId: entity.id,
						from: { scope: { parentId: entity.parentId }, siblings: fromSiblings },
						to: { scope: { parentId: to.ownerId }, siblings: toSiblings },
						toIndex: to.index,
					});
					moved = { ...entity, parentId: to.ownerId };
				} else {
					// A request always belongs to a collection: there is no requests
					// block at the root, so a placement that names one is refused
					// rather than sent for the engine to reject.
					if (!to.ownerId) return null;
					const fromSiblings = requestSiblings(entity.collectionId);
					const toSiblings =
						entity.collectionId === to.ownerId
							? fromSiblings
							: requestSiblings(to.ownerId);
					blockSize =
						entity.collectionId === to.ownerId
							? toSiblings.length
							: toSiblings.length + 1;
					plan = planRequestMove({
						movedId: entity.id,
						from: {
							scope: { collectionId: entity.collectionId },
							siblings: fromSiblings,
						},
						to: { scope: { collectionId: to.ownerId }, siblings: toSiblings },
						toIndex: to.index,
					});
					moved = { ...entity, collectionId: to.ownerId };
				}
			} catch (error) {
				// The math throws when the row is not where the caller thinks it is -
				// an Undo clicked after the tree changed under it, or a drop resolved
				// against a list a refetch has since replaced. Loud, not silent: the
				// move did not happen and the user has to know that, but it is not a
				// crash inside a toast's click handler.
				useToastStore.getState().showToast({
					message:
						error instanceof Error
							? `Couldn't move ${entity.name}: ${error.message}`
							: `Couldn't move ${entity.name}`,
					variant: "error",
				});
				return null;
			}

			if (isEmptyPlan(plan)) return null;
			reorder.mutate(plan);

			const landedAt = Math.min(to.index, Math.max(blockSize - 1, 0));
			setAnnouncement(
				`Moved ${entity.name} to position ${landedAt + 1} of ${blockSize} in ${nameOf(to.ownerId)}`
			);
			revealEntity(moved);
			return { from, moved };
		},
		[nameOf, placementOf, reorder, requestSiblings, revealEntity]
	);

	/**
	 * A move, plus the offer to take it back.
	 *
	 * Only across parents: a misdrop inside one folder is one drag away from
	 * being fixed, while a row that has landed in a folder the user was not
	 * looking at is the complaint every tree with drag-and-drop collects. The
	 * undo itself is offered no undo - toggling a row between two folders with
	 * a stack of identical toasts is worse than the misdrop.
	 */
	const applyPlacement = useCallback(
		(entity: TreeEntity, to: Placement, options: { undoable: boolean }) => {
			const result = writeMove(entity, to);
			if (!result || !options.undoable || result.from.ownerId === to.ownerId) return;
			useToastStore.getState().showToast({
				message: `Moved ${entity.name} to ${nameOf(to.ownerId)}`,
				variant: "info",
				action: {
					label: "Undo",
					altText: `Undo moving ${entity.name}`,
					onClick: () => writeMove(result.moved, result.from),
				},
			});
		},
		[nameOf, writeMove]
	);

	/**
	 * The row and edge the indicator draws on, derived from the destination
	 * rather than from the pointer: a request dropped between two folders lands
	 * at the head of that parent's requests, and the line has to be drawn there
	 * rather than where the pointer is.
	 */
	const indicatorFor = useCallback(
		(entity: TreeEntity, destination: DropDestination): CollectionTreeDropTarget | null => {
			if (destination.anchorId) {
				return { id: destination.anchorId, position: destination.placement };
			}
			const block =
				destination.block === "collections"
					? collectionSiblings(dataRef.current.collections, destination.ownerId)
					: destination.ownerId
						? requestSiblings(destination.ownerId)
						: [];
			const rows = block.filter((row) => row.id !== entity.id);
			if (rows.length === 0) {
				return destination.ownerId ? { id: destination.ownerId, position: "inside" } : null;
			}
			return destination.placement === "before"
				? { id: rows[0].id, position: "before" }
				: { id: rows[rows.length - 1].id, position: "after" };
		},
		[requestSiblings]
	);

	/* ── Auto-scroll ──────────────────────────────────────────────────────── */

	const scrollContainer = useCallback(
		() => treeRef.current?.closest<HTMLElement>("[data-drawer-body]") ?? null,
		[treeRef]
	);

	const stopAutoScroll = useCallback(() => {
		const state = autoScrollRef.current;
		if (state.frame !== null) cancelAnimationFrame(state.frame);
		autoScrollRef.current = { direction: 0, frame: null };
	}, []);

	const startAutoScroll = useCallback(
		(direction: number) => {
			// The loop function is local so it can recurse: a `useCallback` that
			// schedules itself is a value referring to itself across renders, and
			// the frame would keep calling whichever version armed it.
			const step = () => {
				const container = scrollContainer();
				if (!container || autoScrollRef.current.direction === 0) return;
				container.scrollTop += autoScrollRef.current.direction * AUTO_SCROLL_STEP_PX;
				autoScrollRef.current.frame = requestAnimationFrame(step);
			};
			autoScrollRef.current = { direction, frame: requestAnimationFrame(step) };
		},
		[scrollContainer]
	);

	const updateAutoScroll = useCallback(
		(clientY: number) => {
			const container = scrollContainer();
			// Nothing to scroll (and jsdom, where every box measures zero): a band
			// test against a zero-height rect would otherwise scroll forever.
			if (!container || container.scrollHeight <= container.clientHeight) {
				stopAutoScroll();
				return;
			}
			const rect = container.getBoundingClientRect();
			let direction = 0;
			if (clientY < rect.top + AUTO_SCROLL_BAND_PX) direction = -1;
			else if (clientY > rect.bottom - AUTO_SCROLL_BAND_PX) direction = 1;
			if (direction === autoScrollRef.current.direction) return;
			stopAutoScroll();
			if (direction === 0) return;
			startAutoScroll(direction);
		},
		[scrollContainer, startAutoScroll, stopAutoScroll]
	);

	/* ── Spring-loaded folders ────────────────────────────────────────────── */

	const clearSpring = useCallback(() => {
		if (springRef.current) clearTimeout(springRef.current.timer);
		springRef.current = null;
	}, []);

	/**
	 * Start the countdown to opening @p target, or cancel one in flight.
	 *
	 * @param target The folder the drop would land **inside**, and nothing else
	 *   (issue #891). Passing whichever row resolved a destination opened folders
	 *   the drop was only landing *beside*: the edge quarters of a folder row are
	 *   the reorder bands, so lining a reorder up next to a collapsed folder
	 *   sprang it open, moved every row below it and left the user aiming at a
	 *   seam that was no longer there. `null` cancels, which is what makes
	 *   sliding out of the inside band disarm a spring that has not fired.
	 */
	const armSpring = useCallback(
		(target: TreeEntity | null) => {
			const id = target?.kind === "collection" ? target.id : null;
			if (!id || expandedCollectionIds.has(id)) {
				clearSpring();
				return;
			}
			if (springRef.current?.id === id) return;
			clearSpring();
			springRef.current = {
				id,
				timer: setTimeout(() => {
					springRef.current = null;
					// `expandCollection`, not a local set: the reveal effect owns the
					// expanded set and skips what is already open, so a spring-open
					// during a drag cannot fight it.
					expandCollection(id);
				}, TIMING.TREE_SPRING_LOAD_MS),
			};
		},
		[clearSpring, expandCollection, expandedCollectionIds]
	);

	/* ── The drag itself ──────────────────────────────────────────────────── */

	const endDrag = useCallback(() => {
		clearSpring();
		stopAutoScroll();
		const pressed = pressedRef.current;
		if (pressed?.el.hasPointerCapture?.(pressed.pointerId)) {
			pressed.el.releasePointerCapture(pressed.pointerId);
		}
		pressedRef.current = null;
		destinationRef.current = null;
		setDragging(null);
		setDropTarget(null);
	}, [clearSpring, stopAutoScroll]);

	const hasUnsavedEdits = useCallback((entity: TreeEntity): boolean => {
		if (entity.kind !== "request") return false;
		// Two writers on one row is the clobber family: the tab's auto-save holds
		// the row's contents while a move rewrites its owner and order.
		return (
			useSaveStore.getState().contexts.get(`request-${entity.id}`)?.hasPendingChanges === true
		);
	}, []);

	const onPointerDown = useCallback(
		(e: React.PointerEvent<HTMLElement>, entity: TreeEntity) => {
			if (e.button !== 0) return;
			// An open row menu is a React child of this row but not a DOM one.
			if (!isOwnEvent(e)) return;
			// The chevron, the ⋯ menu and a rename field are their own controls;
			// a press on one of them is not a press on the row.
			if (
				e.target instanceof Element &&
				e.target.closest("[data-tree-menu],[data-tree-toggle],input,textarea")
			) {
				return;
			}
			if (isRowBusy(entity.id)) return;
			if (hasUnsavedEdits(entity)) {
				useToastStore.getState().showToast({
					message: `Saving ${entity.name} - try again in a moment`,
					variant: "info",
				});
				return;
			}
			gestureRef.current = pressGesture({ x: e.clientX, y: e.clientY });
			pressedRef.current = { entity, pointerId: e.pointerId, el: e.currentTarget };
			// Capture keeps `pointermove` coming to this row even when the pointer
			// leaves it, which is what makes auto-scroll and a drop on a row far
			// away work at all. jsdom has neither method, hence the guards.
			e.currentTarget.setPointerCapture?.(e.pointerId);
		},
		[hasUnsavedEdits, isRowBusy]
	);

	const onPointerMove = useCallback(
		(e: React.PointerEvent<HTMLElement>) => {
			const pressed = pressedRef.current;
			// `isOwnEvent` again for the same reason as the press: while a drag is
			// live the row holds the pointer capture, so every real move targets
			// the row - anything else reaching here came through a portal.
			if (!pressed || !isOwnEvent(e)) return;

			const next = moveGesture(gestureRef.current, { x: e.clientX, y: e.clientY });
			if (next !== gestureRef.current) {
				gestureRef.current = next;
				if (next.phase === "dragging") setDragging(pressed.entity);
			}
			if (gestureRef.current.phase !== "dragging") return;

			const under = document.elementFromPoint?.(e.clientX, e.clientY) ?? null;
			const row = under?.closest("[data-collection-id],[data-request-id]") ?? null;
			const target = entityFromRow(row);

			let destination: DropDestination | null = null;
			// The folder a spring would open: only ever the one the drop lands
			// *inside*. Tracked beside `destination` rather than derived from it,
			// because a destination alone cannot answer this - "before Beta" and
			// "into Beta" are both drops Beta's row resolved, and only the second
			// is a request to see what is in it.
			let springTarget: TreeEntity | null = null;
			if (target && !isRowBusy(target.id)) {
				const rect = (row as HTMLElement).getBoundingClientRect();
				const zone = zoneAt(
					e.clientY - rect.top,
					rect.height,
					target.kind === "collection"
				);
				// A folder cannot be dropped into its own subtree; the engine's
				// cycle guard stays the backstop, this is what greys the rows.
				const intoOwnSubtree =
					pressed.entity.kind === "collection" &&
					isDescendant(target.id, pressed.entity.id, dataRef.current.collections);
				if (!intoOwnSubtree) {
					destination = resolveDrop({ dragged: pressed.entity, target, zone });
					if (destination && zone === "inside") springTarget = target;
				}
			}

			destinationRef.current = destination;
			const indicator = destination ? indicatorFor(pressed.entity, destination) : null;
			setDropTarget((current) =>
				current?.id === indicator?.id && current?.position === indicator?.position
					? current
					: indicator
			);
			armSpring(springTarget);
			updateAutoScroll(e.clientY);
		},
		[armSpring, indicatorFor, isRowBusy, updateAutoScroll]
	);

	const onPointerUp = useCallback(
		(e: React.PointerEvent<HTMLElement>) => {
			const pressed = pressedRef.current;
			if (!pressed || !isOwnEvent(e)) return;
			const dropped = gestureRef.current.phase === "dragging";
			gestureRef.current = releaseGesture(gestureRef.current);
			const destination = destinationRef.current;
			endDrag();
			if (!dropped || !destination) return;

			const siblings =
				destination.block === "collections"
					? collectionSiblings(dataRef.current.collections, destination.ownerId)
					: destination.ownerId
						? requestSiblings(destination.ownerId)
						: [];
			const index = indexInBlock(siblings, pressed.entity.id, destination);
			if (index === null) return;
			applyPlacement(
				pressed.entity,
				{ ownerId: destination.ownerId, index },
				{ undoable: true }
			);
		},
		[applyPlacement, endDrag, requestSiblings]
	);

	const onPointerCancel = useCallback(() => {
		gestureRef.current = cancelGesture(gestureRef.current);
		endDrag();
	}, [endDrag]);

	const onClickCapture = useCallback((e: React.MouseEvent<HTMLElement>) => {
		// A menu item's click bubbles through the row it belongs to. Swallowing
		// it would be the drag eating the very action the user chose *because*
		// the drag before it left a suppression armed.
		if (!isOwnEvent(e)) return;
		const { gesture, suppressed } = consumeClick(gestureRef.current);
		gestureRef.current = gesture;
		if (!suppressed) return;
		e.preventDefault();
		e.stopPropagation();
	}, []);

	// Escape cancels mid-drag. On `window` rather than the row: the row is not
	// focused during a drag, so a keydown never reaches it.
	useEffect(() => {
		if (!dragging) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			gestureRef.current = cancelGesture(gestureRef.current);
			endDrag();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [dragging, endDrag]);

	// A drag interrupted by an unmount leaves a 700ms timer and a scroll frame
	// behind; both hold a callback into a tree that no longer exists.
	useEffect(() => {
		return () => {
			clearSpring();
			stopAutoScroll();
		};
	}, [clearSpring, stopAutoScroll]);

	/* ── Keyboard move ────────────────────────────────────────────────────── */

	const moveByKeyboard = useCallback(
		(entity: TreeEntity, direction: TreeMoveDirection) => {
			const { collections: allCollections } = dataRef.current;
			const owner = entity.kind === "collection" ? entity.parentId : entity.collectionId;
			const block: OrderedRow[] =
				entity.kind === "collection"
					? collectionSiblings(allCollections, entity.parentId)
					: [...requestSiblings(entity.collectionId)];
			const at = block.findIndex((row) => row.id === entity.id);
			if (at < 0) return;

			if (direction === "up" || direction === "down") {
				const next = direction === "up" ? at - 1 : at + 1;
				if (next < 0 || next >= block.length) {
					setAnnouncement(
						`${entity.name} is already ${direction === "up" ? "first" : "last"} in ${nameOf(owner)}`
					);
					return;
				}
				applyPlacement(entity, { ownerId: owner, index: next }, { undoable: false });
				return;
			}

			if (direction === "in") {
				// The folder rendered immediately above this row: the previous
				// subfolder for a folder, and the last subfolder for the first
				// request (requests follow the folders in every group).
				const folders = collectionSiblings(
					allCollections,
					entity.kind === "collection" ? entity.parentId : (owner as string)
				);
				const into =
					entity.kind === "collection"
						? at > 0
							? folders[at - 1]
							: undefined
						: at === 0
							? folders[folders.length - 1]
							: undefined;
				if (!into) {
					setAnnouncement(`No folder above ${entity.name} to move it into`);
					return;
				}
				const size =
					entity.kind === "collection"
						? collectionSiblings(allCollections, into.id).length
						: requestSiblings(into.id).length;
				expandCollection(into.id);
				applyPlacement(entity, { ownerId: into.id, index: size }, { undoable: true });
				return;
			}

			// "out": after the parent among its own siblings for a folder; into the
			// grandparent's requests for a request, which has no position among
			// folders to be "after".
			if (owner === null) {
				setAnnouncement(`${entity.name} is already at the top level`);
				return;
			}
			const parent = allCollections.find((c) => c.id === owner);
			const grandparentId = parent?.parentId ?? null;
			if (entity.kind === "collection") {
				const uncles = collectionSiblings(allCollections, grandparentId);
				const parentAt = uncles.findIndex((c) => c.id === owner);
				applyPlacement(
					entity,
					{ ownerId: grandparentId, index: parentAt + 1 },
					{ undoable: true }
				);
				return;
			}
			if (!grandparentId) {
				setAnnouncement(`${entity.name} cannot move out of ${nameOf(owner)}`);
				return;
			}
			applyPlacement(
				entity,
				{ ownerId: grandparentId, index: requestSiblings(grandparentId).length },
				{ undoable: true }
			);
		},
		[applyPlacement, expandCollection, nameOf, requestSiblings]
	);

	/* ── "Move to..." ─────────────────────────────────────────────────────── */

	const moveToOwner = useCallback(
		(entity: TreeEntity, ownerId: string | null) => {
			setMoveTarget(null);
			const size =
				entity.kind === "collection"
					? collectionSiblings(dataRef.current.collections, ownerId).length
					: ownerId
						? requestSiblings(ownerId).length
						: 0;
			if (ownerId) expandCollection(ownerId);
			applyPlacement(entity, { ownerId, index: size }, { undoable: true });
		},
		[applyPlacement, expandCollection, requestSiblings]
	);

	const dnd = useMemo<CollectionTreeDnd>(
		() => ({
			draggingId: dragging?.id ?? null,
			dropTarget,
			rowHandlers: (entity: TreeEntity) => ({
				onPointerDown: (e: React.PointerEvent<HTMLElement>) => onPointerDown(e, entity),
				onPointerMove,
				onPointerUp,
				onPointerCancel,
				onClickCapture,
			}),
			isDropBlocked: (entity: TreeEntity) => {
				if (!dragging) return false;
				if (entity.id === dragging.id) return true;
				if (
					dragging.kind === "collection" &&
					isDescendant(entity.id, dragging.id, dataRef.current.collections)
				) {
					return true;
				}
				// No band of this row names a destination the dragged row could
				// take - a folder over a request row, or a request over a root
				// folder's edges. Asked of the same resolver the drop uses, so what
				// is greyed and what is refused cannot disagree.
				return (["before", "inside", "after"] as const).every(
					(zone) => resolveDrop({ dragged: dragging, target: entity, zone }) === null
				);
			},
			moveByKeyboard,
			moveAction: (entity: TreeEntity) => ({
				label: "Move to...",
				icon: ArrowRightLeft,
				onSelect: () => setMoveTarget(entity),
			}),
		}),
		[
			dragging,
			dropTarget,
			moveByKeyboard,
			onClickCapture,
			onPointerCancel,
			onPointerDown,
			onPointerMove,
			onPointerUp,
		]
	);

	const closeMoveDialog = useCallback(() => setMoveTarget(null), []);

	return { dnd, announcement, moveTarget, closeMoveDialog, moveToOwner };
}
