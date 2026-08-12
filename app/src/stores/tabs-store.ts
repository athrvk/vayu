/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import { useSaveStore, type SaveContext } from "./save-store";
import { useResponseStore } from "./response-store";

export type TabType =
	| "welcome"
	| "request"
	| "collection"
	| "dashboard"
	| "run"
	| "variables"
	| "settings"
	| "inbox";

export interface Tab {
	id: string; // unique tab instance ID (nanoid or crypto.randomUUID)
	type: TabType;
	entityId: string | null; // requestId, collectionId, runId - null for singletons
}

const MAX_OPEN_TABS = 12;

// Singletons: only one tab of this type can exist at a time
const SINGLETON_TYPES: TabType[] = ["welcome", "variables", "settings", "inbox"];

// These tab types are exempt from LRU auto-close
const LRU_EXEMPT_TYPES: TabType[] = ["dashboard"];

interface TabsState {
	openTabs: Tab[];
	activeTabId: string | null;
	/**
	 * When each open tab was last focused, in epoch ms.
	 *
	 * Read by the command palette, which lists open tabs most-recently-used
	 * first - the order a switcher has to have, and one `openTabs` cannot give:
	 * that array is insertion order, so the tab you were just in sits wherever
	 * it was opened.
	 *
	 * Session-scoped by design (absent from `partialize`). Tabs *are* restored
	 * across launches, so a persisted copy would rank a restored list by
	 * yesterday's attention; an empty map falls back to strip order, which is
	 * what the user sees on screen anyway. Entries for closed tabs are dropped
	 * on the next focus rather than in every close path - nothing reads a
	 * stamp for a tab that is no longer open.
	 */
	tabFocusedAt: Record<string, number>;

	openTab: (tab: Omit<Tab, "id">) => void;
	closeTab: (tabId: string) => void;
	/**
	 * Close every tab bound to one of the given entity ids (e.g. after deletion).
	 *
	 * `type` narrows the sweep to one kind of tab. Ids are engine-generated and
	 * do not collide across families, so it is not needed for correctness - it
	 * states at the call site which tabs a deletion is allowed to close, which
	 * is the difference between "close the run tabs for these deleted runs" and
	 * "close whatever happens to carry these ids".
	 */
	closeTabsForEntities: (entityIds: Iterable<string>, type?: TabType) => void;
	focusTab: (tabId: string) => void;
}

/**
 * Does this tab hold unsaved edits?
 *
 * The save registry is keyed by *editor*, and editors do not line up with tabs.
 * `settings` and `variables` are singletons with no `entityId`, so the old
 * `request-${entityId}` lookup returned nothing for them and read as clean:
 * a dirty Settings tab was eligible for LRU eviction, taking its edits with it.
 * The real keys are `settings` (`SettingsMain`) and `globals-editor` /
 * `environment-<id>` / `collection-<id>` (`VariableTableEditor`).
 *
 * The variables tab hosts whichever of those three editors the sidebar has
 * selected and a `Tab` does not record which, so any dirty variable-editor
 * context counts as that tab's. A `collection-<id>` context can equally come
 * from a collection tab's Variables sub-tab, so this over-matches - which is
 * the safe direction. Over-matching keeps a tab that could have closed;
 * under-matching discards someone's work.
 *
 * A collection tab hosts more than that one editor, and its siblings key
 * themselves off the same id with a suffix: `collection-<id>-info`, `-auth`,
 * `-preRequestScript`, `-postRequestScript` (`useDraftSaveContext`). Matching
 * only the exact key read every one of those as clean, so the case scans for
 * its own id plus that suffix family. It stays scoped to `tab.entityId` - a
 * blanket `collection-` prefix would make every collection tab dirty whenever
 * any one of them was.
 */
function isTabDirty(tab: Tab, contexts: Map<string, SaveContext>): boolean {
	const isDirty = (key: string) => contexts.get(key)?.hasPendingChanges === true;

	switch (tab.type) {
		case "request":
			return tab.entityId !== null && isDirty(`request-${tab.entityId}`);
		case "collection": {
			if (tab.entityId === null) return false;
			const own = `collection-${tab.entityId}`;
			for (const [key, ctx] of contexts) {
				if (!ctx.hasPendingChanges) continue;
				if (key === own || key.startsWith(`${own}-`)) return true;
			}
			return false;
		}
		case "settings":
			return isDirty("settings");
		case "variables":
			for (const [key, ctx] of contexts) {
				if (!ctx.hasPendingChanges) continue;
				if (
					key === "globals-editor" ||
					key.startsWith("environment-") ||
					key.startsWith("collection-")
				) {
					return true;
				}
			}
			return false;
		case "inbox":
			/*
			 * Never dirty, stated rather than left to the default.
			 *
			 * An inbox holds no draft: its listener and its canned response are
			 * engine state, written through as they are changed. The explicit
			 * case is here because a *missing* one reads as clean too, and the
			 * two are indistinguishable to the next reader - which is how a
			 * dirty Settings tab became LRU-evictable.
			 */
			return false;
		// welcome, dashboard and run register no save context at all.
		default:
			return false;
	}
}

/** The slice of the store that reaches localStorage - see `partialize` below. */
interface PersistedTabs {
	openTabs: Tab[];
	activeTabId: string | null;
}

/**
 * Version translation for the persisted tab list.
 *
 * zustand *discards* a payload whose stamped version does not match `version`
 * unless a `migrate` is supplied - it logs to the console and hands the store
 * its defaults - so a future bump without this would silently close everyone's
 * tabs. This is where that bump goes: add a branch per old version. Until then
 * there is one shape, and the only work is refusing a payload that is not it.
 */
function migrateTabs(persisted: unknown): PersistedTabs {
	const stored = (persisted ?? {}) as Partial<PersistedTabs>;
	return {
		openTabs: Array.isArray(stored.openTabs) ? stored.openTabs : [],
		activeTabId: typeof stored.activeTabId === "string" ? stored.activeTabId : null,
	};
}

/**
 * Stamp `focusedId` as focused now, keeping only the tabs that still exist.
 *
 * Pruning here rather than in each close path is what keeps the close paths
 * unchanged: a stamp for a closed tab is unreachable (the palette only ranks
 * open tabs) and is dropped the next time anything is focused.
 */
function stampFocus(
	previous: Record<string, number>,
	tabs: Tab[],
	focusedId: string
): Record<string, number> {
	const live: Record<string, number> = {};
	for (const tab of tabs) {
		const at = previous[tab.id];
		if (at !== undefined) live[tab.id] = at;
	}
	live[focusedId] = Date.now();
	return live;
}

function makeId() {
	return typeof crypto !== "undefined" && crypto.randomUUID
		? crypto.randomUUID()
		: Math.random().toString(36).slice(2);
}

export const useTabsStore = create<TabsState>()(
	persist(
		(set, get) => ({
			openTabs: [],
			activeTabId: null,
			tabFocusedAt: {},

			openTab: (tabDef) => {
				const { openTabs, activeTabId, tabFocusedAt } = get();

				// Dedupe: singletons and entity-keyed tabs
				const isSingleton = SINGLETON_TYPES.includes(tabDef.type);
				const existing = openTabs.find((t) =>
					isSingleton
						? t.type === tabDef.type
						: t.type === tabDef.type && t.entityId === tabDef.entityId
				);
				if (existing) {
					set({
						activeTabId: existing.id,
						tabFocusedAt: stampFocus(tabFocusedAt, openTabs, existing.id),
					});
					return;
				}

				const newTab: Tab = { ...tabDef, id: makeId() };
				let tabs = [...openTabs, newTab];

				// LRU eviction when over cap. Nothing is flushed on the way out:
				// the predicate below refuses to select a dirty tab, so the flush
				// branch that used to sit here was unreachable by construction - and
				// had it ever run, `void ctx.save()` would have dropped the
				// rejection. Eviction simply never takes unsaved work.
				if (tabs.length > MAX_OPEN_TABS) {
					// Find the oldest non-active, non-exempt, non-dirty tab
					const contexts = useSaveStore.getState().contexts;
					const evictIndex = tabs.findIndex((t) => {
						if (t.id === activeTabId) return false;
						if (LRU_EXEMPT_TYPES.includes(t.type)) return false;
						return !isTabDirty(t, contexts);
					});
					if (evictIndex !== -1) {
						tabs.splice(evictIndex, 1);
					}
				}

				set({
					openTabs: tabs,
					activeTabId: newTab.id,
					tabFocusedAt: stampFocus(tabFocusedAt, tabs, newTab.id),
				});
			},

			closeTab: (tabId) => {
				const { openTabs, activeTabId } = get();
				const idx = openTabs.findIndex((t) => t.id === tabId);
				if (idx === -1) return;

				const remaining = openTabs.filter((t) => t.id !== tabId);
				let nextActiveId = activeTabId;

				if (activeTabId === tabId) {
					// Focus the tab to the left, or the new last tab
					const newFocus = remaining[Math.max(0, idx - 1)];
					nextActiveId = newFocus?.id ?? null;
				}

				set({ openTabs: remaining, activeTabId: nextActiveId });
			},

			closeTabsForEntities: (entityIds, type) => {
				const ids = new Set(entityIds);
				if (ids.size === 0) return;

				// A delete that can name a request takes its response with it: the
				// collection tree reaches here after deleting a request or a whole
				// collection, nothing else evicts from that map, and each entry
				// holds a body plus its raw copy. Skipped for a `type`-scoped sweep
				// that is not about requests - `"run"` ids cannot key a response, so
				// walking them would only look like it meant something. Done before
				// the early return below, since a deleted request with no open tab
				// still leaves a response behind.
				if (type === undefined || type === "request") {
					const { clearResponse } = useResponseStore.getState();
					for (const id of ids) clearResponse(id);
				}

				const { openTabs, activeTabId } = get();
				const shouldClose = (t: Tab) =>
					t.entityId !== null &&
					ids.has(t.entityId) &&
					(type === undefined || t.type === type);

				const remaining = openTabs.filter((t) => !shouldClose(t));
				if (remaining.length === openTabs.length) return; // nothing matched

				let nextActiveId = activeTabId;
				const activeIdx = openTabs.findIndex((t) => t.id === activeTabId);
				if (activeIdx !== -1 && shouldClose(openTabs[activeIdx])) {
					// Active tab is closing: focus the nearest survivor, preferring the
					// left (matches closeTab's behavior).
					let pick: Tab | undefined;
					for (let i = activeIdx - 1; i >= 0 && !pick; i--) {
						if (!shouldClose(openTabs[i])) pick = openTabs[i];
					}
					for (let i = activeIdx + 1; i < openTabs.length && !pick; i++) {
						if (!shouldClose(openTabs[i])) pick = openTabs[i];
					}
					nextActiveId = pick?.id ?? null;
				}

				set({ openTabs: remaining, activeTabId: nextActiveId });
			},

			focusTab: (tabId) => {
				const { openTabs, tabFocusedAt } = get();
				if (openTabs.find((t) => t.id === tabId)) {
					set({
						activeTabId: tabId,
						tabFocusedAt: stampFocus(tabFocusedAt, openTabs, tabId),
					});
				}
			},
		}),
		{
			name: STORAGE_KEYS.TABS_STORE,
			version: 1,
			partialize: (state) => ({
				openTabs: state.openTabs,
				activeTabId: state.activeTabId,
			}),
			migrate: migrateTabs,
		}
	)
);
