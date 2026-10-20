/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where a drop lands in a one-dimensional list, as arithmetic over positions.
 *
 * A "slot" is the gap a dragged item would be inserted into: slot 0 is before
 * the first item, slot `n` after the last. `slotAt` reads one off a pointer
 * coordinate, `landingIndex` turns it into the index the item ends up at once it
 * has left its old place; a drop is a no-op when that equals where it started.
 *
 * Pure and node-tested, so a surface (a tab strip, a list) shares the maths
 * without sharing a DOM. The collection tree does not use it: its drops resolve
 * against a parent and an anchor row, and it keeps its own `indexAmongSiblings`
 * (`useTreeDnd.ts`) deliberately.
 */

/** The span one item occupies along the drag axis, in the pointer's coordinates. */
export interface ItemExtent {
	start: number;
	end: number;
}

/**
 * An index or slot comes from a measured list, so a fraction or a negative is a
 * caller bug and throws, as `reorder-math`'s `clamp` does for a fractional index.
 */
function assertIndex(name: string, value: number): void {
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${name} must be a non-negative integer, got ${value}`);
	}
}

/**
 * The slot `coordinate` falls in: the number of items whose midpoint lies
 * before it. A pointer exactly on a midpoint belongs to the earlier slot, so a
 * drag does not flicker between two slots at the boundary. 0 for an empty list.
 */
export function slotAt(extents: readonly ItemExtent[], coordinate: number): number {
	if (!Number.isFinite(coordinate)) {
		throw new Error(`Drop coordinate must be a finite number, got ${coordinate}`);
	}
	return extents.filter(({ start, end }) => (start + end) / 2 < coordinate).length;
}

/**
 * The index the dragged item ends up at when dropped in slot `insertBefore`.
 * The slot counts the item's own old place, so a slot after it lands one lower
 * once it has been lifted out.
 */
export function landingIndex(insertBefore: number, fromIndex: number): number {
	assertIndex("Slot", insertBefore);
	assertIndex("Source index", fromIndex);
	return insertBefore > fromIndex ? insertBefore - 1 : insertBefore;
}
