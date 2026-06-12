/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useSaveStore } from "./save-store";

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
	entityId: string | null; // requestId, collectionId, runId — null for singletons
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
	focusTab: (tabId: string) => void;
	/** Replace the active tab in place (used when welcome tab spawns a request) */
	replaceActiveTab: (tab: Omit<Tab, "id">) => void;
	/** Close all tabs */
	closeAll: () => void;
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

				// LRU eviction when over cap
				if (tabs.length > MAX_OPEN_TABS) {
					// Find the oldest non-active, non-exempt, non-dirty tab
					const contexts = useSaveStore.getState().contexts;
					const evictIndex = tabs.findIndex((t) => {
						if (t.id === activeTabId) return false;
						if (LRU_EXEMPT_TYPES.includes(t.type)) return false;
						const ctx = t.entityId ? contexts.get(`request-${t.entityId}`) : null;
						return !ctx?.hasPendingChanges;
					});
					if (evictIndex !== -1) {
						const evicted = tabs[evictIndex];
						// Flush any lingering save context for the evicted tab
						if (evicted.entityId) {
							const ctx = contexts.get(`request-${evicted.entityId}`);
							if (ctx?.hasPendingChanges) void ctx.save();
						}
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
			name: "vayu.tabs",
			version: 1,
			partialize: (state) => ({
				openTabs: state.openTabs,
				activeTabId: state.activeTabId,
			}),
		}
	)
);
