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

export type TabType =
	| "welcome"
	| "request"
	| "collection"
	| "dashboard"
	| "run"
	| "variables"
	| "settings";

export interface Tab {
	id: string; // unique tab instance ID (nanoid or crypto.randomUUID)
	type: TabType;
	entityId: string | null; // requestId, collectionId, runId - null for singletons
}

const MAX_OPEN_TABS = 12;

// Singletons: only one tab of this type can exist at a time
const SINGLETON_TYPES: TabType[] = ["welcome", "variables", "settings"];

// These tab types are exempt from LRU auto-close
const LRU_EXEMPT_TYPES: TabType[] = ["dashboard"];

interface TabsState {
	openTabs: Tab[];
	activeTabId: string | null;

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
	/** Replace the active tab in place (used when welcome tab spawns a request) */
	replaceActiveTab: (tab: Omit<Tab, "id">) => void;
	/** Close all tabs */
	closeAll: () => void;
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
 */
function isTabDirty(tab: Tab, contexts: Map<string, SaveContext>): boolean {
	const isDirty = (key: string) => contexts.get(key)?.hasPendingChanges === true;

	switch (tab.type) {
		case "request":
			return tab.entityId !== null && isDirty(`request-${tab.entityId}`);
		case "collection":
			return tab.entityId !== null && isDirty(`collection-${tab.entityId}`);
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
		// welcome, dashboard and run register no save context at all.
		default:
			return false;
	}
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

			openTab: (tabDef) => {
				const { openTabs, activeTabId } = get();

				// Dedupe: singletons and entity-keyed tabs
				const isSingleton = SINGLETON_TYPES.includes(tabDef.type);
				const existing = openTabs.find((t) =>
					isSingleton
						? t.type === tabDef.type
						: t.type === tabDef.type && t.entityId === tabDef.entityId
				);
				if (existing) {
					set({ activeTabId: existing.id });
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

				set({ openTabs: tabs, activeTabId: newTab.id });
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
				if (get().openTabs.find((t) => t.id === tabId)) {
					set({ activeTabId: tabId });
				}
			},

			replaceActiveTab: (tabDef) => {
				const { openTabs, activeTabId } = get();
				if (!activeTabId) {
					get().openTab(tabDef);
					return;
				}
				// If a tab for this entity already exists elsewhere, focus it instead
				const isSingleton = SINGLETON_TYPES.includes(tabDef.type);
				const existing = openTabs.find(
					(t) =>
						t.id !== activeTabId &&
						(isSingleton
							? t.type === tabDef.type
							: t.type === tabDef.type && t.entityId === tabDef.entityId)
				);
				if (existing) {
					set({ activeTabId: existing.id });
					return;
				}
				const newTab: Tab = { ...tabDef, id: activeTabId };
				set({ openTabs: openTabs.map((t) => (t.id === activeTabId ? newTab : t)) });
			},

			closeAll: () => set({ openTabs: [], activeTabId: null }),
		}),
		{
			name: STORAGE_KEYS.TABS_STORE,
			version: 1,
			partialize: (state) => ({
				openTabs: state.openTabs,
				activeTabId: state.activeTabId,
			}),
		}
	)
);
