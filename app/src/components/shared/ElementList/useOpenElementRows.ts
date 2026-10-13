/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Binds `ElementList`'s controlled `openIds` / `onOpenChange` to
 * `tab-selection-store`, keyed by the owning request's or collection's id, so
 * an expanded row stays expanded when `Shell` unmounts the surface or when a
 * request tab swap reuses the builder instance.
 *
 * Subscribes by selector rather than reading `getState()`: on the same-instance
 * swap the id changes under a mounted host, and the other entity's set has to
 * arrive as a re-render.
 */

import { useCallback } from "react";
import { useTabSelectionStore } from "@/stores";
import type { ElementListProps } from "./index";

/** One shared empty set, so an entity with nothing open hands the list a stable reference. */
const NONE_OPEN: ReadonlySet<string> = new Set();

/**
 * Spread onto `ElementList`. With no `entityId` (an unsaved request, the
 * stored-run copy) it returns nothing, and the list keeps its own state.
 */
export function useOpenElementRows(
	entityId: string | null | undefined
): Pick<ElementListProps, "openIds" | "onOpenChange"> {
	const openIds = useTabSelectionStore((s) =>
		entityId ? s.openElementRows.get(entityId) : undefined
	);
	const setElementRowOpen = useTabSelectionStore((s) => s.setElementRowOpen);
	const onOpenChange = useCallback(
		(elementId: string, open: boolean) => {
			if (entityId) setElementRowOpen(entityId, elementId, open);
		},
		[entityId, setElementRowOpen]
	);

	if (!entityId) return {};
	return { openIds: openIds ?? NONE_OPEN, onOpenChange };
}
