/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the schema explorer remembers: whether it is open, and per schema, what
 * the user has searched for, opened and scrolled to.
 *
 * **A store rather than component state, because the pane is unmounted often
 * and for no reason the user did.** Radix tears the Body tab down on every
 * glance at Headers or Auth (`utils/body-drafts.ts` exists for exactly this),
 * and a component-state explorer comes back collapsed to its roots with an
 * empty search box - after a glance the user did not think of as leaving. The
 * body drafts learned this the hard way; this starts where they ended up.
 *
 * **Keyed by schema identity, not by request.** The key is the schema cache's
 * own (`schemaCacheKey`), so two requests against one endpoint share the tree
 * they have opened, and the same URL reached with different credentials does
 * not - which is the same rule the schema itself is cached under, for the same
 * reason. Deliberately in memory only: an expansion set is a description of a
 * schema that may not exist on the next launch.
 */

import { create } from "zustand";

export interface ExplorerViewState {
	search: string;
	/** Ids of the expanded rows. An array, so the state stays serialisable. */
	expanded: string[];
	scrollTop: number;
	/**
	 * Whether every row shows its full description rather than one clipped line.
	 *
	 * Per schema, like everything else here: how much documentation a user wants
	 * on screen is a property of the schema they are reading, and an endpoint
	 * that documents nothing has nothing to answer for.
	 */
	showDescriptions: boolean;
}

const EMPTY_VIEW: ExplorerViewState = {
	search: "",
	expanded: [],
	scrollTop: 0,
	showDescriptions: false,
};

/**
 * How many schemas' view states to keep. Matches the schema cache's own cap -
 * a view for a schema that has been evicted describes nothing.
 */
export const EXPLORER_VIEW_MAX_ENTRIES = 8;

interface ExplorerState {
	open: boolean;
	byKey: Record<string, ExplorerViewState>;
	/** Keys least-recently-touched first; every key in `byKey` appears once. */
	lru: string[];
	setOpen: (open: boolean) => void;
	view: (key: string) => ExplorerViewState;
	setSearch: (key: string, search: string) => void;
	toggleExpanded: (key: string, id: string) => void;
	setScrollTop: (key: string, scrollTop: number) => void;
	toggleDescriptions: (key: string) => void;
}

function withView(
	state: ExplorerState,
	key: string,
	next: ExplorerViewState
): Pick<ExplorerState, "byKey" | "lru"> {
	const byKey = { ...state.byKey, [key]: next };
	const lru = [...state.lru.filter((k) => k !== key), key];
	while (lru.length > EXPLORER_VIEW_MAX_ENTRIES) delete byKey[lru.shift()!];
	return { byKey, lru };
}

export const useExplorerStore = create<ExplorerState>((set, get) => ({
	/*
	 * Closed by default. The pane takes width from the query editor, and a user
	 * who has not asked to browse a schema is here to type one.
	 */
	open: false,
	byKey: {},
	lru: [],

	setOpen: (open) => set({ open }),

	view: (key) => get().byKey[key] ?? EMPTY_VIEW,

	setSearch: (key, search) => set((s) => withView(s, key, { ...s.view(key), search })),

	toggleExpanded: (key, id) =>
		set((s) => {
			const current = s.view(key);
			const expanded = current.expanded.includes(id)
				? current.expanded.filter((e) => e !== id)
				: [...current.expanded, id];
			return withView(s, key, { ...current, expanded });
		}),

	setScrollTop: (key, scrollTop) => set((s) => withView(s, key, { ...s.view(key), scrollTop })),

	toggleDescriptions: (key) =>
		set((s) => {
			const current = s.view(key);
			return withView(s, key, { ...current, showDescriptions: !current.showDescriptions });
		}),
}));
