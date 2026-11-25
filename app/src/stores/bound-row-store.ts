/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one data row the open request builder is bound to, for the surfaces that preview a request
 * from outside it (#1074).
 *
 * `RequestBuilderProvider` gives its picked row to its own resolver, which covers every preview
 * *inside* the builder (the URL bar, the params and body, resolved auth; #1062). The tab strip is
 * not below it: `useTabDescriptors` labels every tab from one list-wide resolver, because the strip
 * must know each label to decide how many fit and a hook inside a map is a variable number of
 * hooks. Without this slot a request with no name of its own labels its tab from the environment
 * while the bar one row below shows the file's value.
 *
 * **One slot, not a map.** The builder binds a row for the request it shows, so that is the only
 * request an on-screen preview can be bound for; a row per remembered index would publish rows from
 * a file that is no longer the one loaded. Writing names the request, so a reader checks rather
 * than assumes, and a stale slot cannot silently relabel the next tab.
 *
 * **Never persisted, and cleared with the builder.** The rows must never outlive the send that uses
 * them (see `data-file-store`): a saved row would point at a file the app has not re-read, and a
 * saved index at a row that is no longer the same one.
 */

import { create } from "zustand";

import type { DataFileRow } from "@/services/data-files";

/** The bound row, and which request it belongs to. */
export interface BoundDataRow {
	requestId: string;
	row: DataFileRow;
}

interface BoundRowState {
	/** The row the open builder is bound to, or null when it is bound to none. */
	bound: BoundDataRow | null;
	/**
	 * Publish the row the builder is bound to, replacing whatever stood before. `null` is "bound to
	 * none", written by an ordinary Send, an unsaved request and an unmounting builder, so the slot
	 * cannot outlive the state that justified it.
	 */
	setBoundRow: (bound: BoundDataRow | null) => void;
}

export const useBoundRowStore = create<BoundRowState>((set) => ({
	bound: null,
	setBoundRow: (bound) => set({ bound }),
}));

/**
 * The row bound for @p requestId, or undefined: the read every consumer wants. Named here rather
 * than compared at each call site: "is this slot this request's" keeps a stale publication from
 * relabelling the wrong tab, and a copy in each reader is a copy that can be forgotten.
 */
export function boundRowFor(
	bound: BoundDataRow | null,
	requestId: string | null | undefined
): DataFileRow | undefined {
	if (!bound || !requestId) return undefined;
	return bound.requestId === requestId ? bound.row : undefined;
}
