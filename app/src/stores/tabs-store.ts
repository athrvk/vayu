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

/**
 * Somewhere the user has been - a `Tab` without its instance id (issue #1245).
 *
 * The navigation history is a list of these rather than of tab ids, and that is
 * the whole reason back can reopen a tab the user closed: an id dies with its
 * tab, so a history of ids would name nothing the moment a step of it is closed.
 * A location outlives the tab, and `openTab` takes exactly this shape.
 */
export interface TabLocation {
	type: TabType;
	entityId: string | null;
}

/**
 * Exported because `response-store`'s cache bound is derived from it: that
 * store retains the open tabs' responses plus an equal tail, and a guard there
 * fails if the two numbers drift apart.
 */
export const MAX_OPEN_TABS = 12;

/**
 * Singletons: only one tab of this type can exist at a time.
 *
 * One tab, not one address. Opening a singleton that is already open with a
 * *different* `entityId` retargets the open tab rather than focusing whatever
 * it was showing - the inbox tab is one surface pointed at one inbox, and the
 * drawer row that names inbox B has to be able to show B in it (issue #554).
 * The others are always opened with a null `entityId`, for which retargeting is
 * a no-op.
 */
const SINGLETON_TYPES: TabType[] = ["welcome", "variables", "settings", "inbox"];

// These tab types are exempt from LRU auto-close
const LRU_EXEMPT_TYPES: TabType[] = ["dashboard"];

/**
 * How many places back the history remembers.
 *
 * A browser's is unbounded because a browser session ends; this one is a working
 * set inside a workspace, and fifty steps is well past the "where was I" a user
 * can still picture. The cap is what keeps a long session's history from being
 * an ever-growing list of every request ever visited.
 */
const MAX_NAV_HISTORY = 50;

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
	/**
	 * A collection whose **Spec** tab something outside the collection screen has
	 * pointed at, or `null` (issue #680).
	 *
	 * A collection tab picks its own sub-tab, and `openTab` can only say which
	 * collection to show - so the one navigation that points *into* a collection
	 * (the import dialog offering Sync for a document already bound) needs
	 * somewhere to say which section it meant. `CollectionDetail` reads it when
	 * the named collection is on screen and clears it, so it survives the tab
	 * being opened for the first time and never fires twice.
	 *
	 * Session-scoped like `tabFocusedAt` (absent from `partialize`): it is one
	 * navigation in flight, and a persisted copy would jump a user to the Spec
	 * tab on the next launch for a choice they made yesterday.
	 */
	specTabTarget: string | null;
	/**
	 * A request something outside the builder has pointed at a data row of, or
	 * `null` (issue #730).
	 *
	 * The same shape of navigation as `specTabTarget` and for the same reason:
	 * `openTab` can only name a request, and which row a Send should bind is
	 * state the UrlBar holds. A failed step of a collection run is the one
	 * caller today - "reproduce this step" means its request *and* the row that
	 * iteration bound, and the second half has nowhere else to travel.
	 *
	 * Session-scoped (absent from `partialize`): it is one navigation in
	 * flight, and it points into a data file whose rows are deliberately never
	 * persisted - a remembered index would name a different row in a file that
	 * has since changed.
	 */
	dataRowTarget: { requestId: string; rowIndex: number } | null;
	/**
	 * Every place the user has been in this session, oldest first, with
	 * `navIndex` marking where they are in it (issue #1245).
	 *
	 * A browser's model, and for the browser's reason: "where was I before this"
	 * is a question `tabFocusedAt` cannot answer past one step - it is a set of
	 * stamps, so the second Back has nothing to read - and one that no ordering
	 * of `openTabs` can answer at all, that array being insertion order.
	 *
	 * Here rather than in a store of its own, though it is only read by the
	 * navigation controls: it is derived from the very activations this store
	 * performs, and a second store would have to be told about every one of them
	 * by every caller. `openTab`, `focusTab` and `closeTab` are where a location
	 * changes, so they are where it is recorded.
	 *
	 * Session-scoped by design (absent from `partialize`), like `tabFocusedAt`.
	 * Tabs *are* restored across launches, and a restored history would offer a
	 * Back that walks yesterday's route through today's window - or reopens a
	 * request deleted since. An empty history disables both buttons until the
	 * user goes somewhere, which is what a fresh session should say.
	 */
	navHistory: TabLocation[];
	/**
	 * Where in `navHistory` the user is: the index of the current location, or
	 * `-1` before anything has been visited.
	 *
	 * A cursor rather than two stacks. The forward half is simply the entries
	 * after this index, so nothing has to be moved from one stack to the other on
	 * every step, and the two halves cannot disagree about the present.
	 */
	navIndex: number;

	openTab: (tab: Omit<Tab, "id">) => void;
	/** Show a collection, on its Spec tab - see `specTabTarget`. */
	openCollectionSpecTab: (collectionId: string) => void;
	/** Consume `specTabTarget`, once the collection screen has acted on it. */
	clearSpecTabTarget: () => void;
	/**
	 * Show a request, with one row of its collection's data file selected for
	 * Send-with-row - see `dataRowTarget`.
	 *
	 * A negative or non-integer index is refused rather than stored: it can only
	 * come from a malformed trace, and a picker asked to select row -1 would
	 * open on nothing with no way to tell that from a file that failed to read.
	 */
	openRequestWithDataRow: (requestId: string, rowIndex: number) => void;
	/** Consume `dataRowTarget`, once the request builder has acted on it. */
	clearDataRowTarget: () => void;
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
	/**
	 * Focus the tab `step` places along from the active one, wrapping at both
	 * ends. `1` is the next tab, `-1` the previous.
	 *
	 * Here rather than at the caller for the reason `closeTab` picks its own
	 * replacement: "which tab is next" is one rule, and the ⇧⌘] chord, a future
	 * menu item and anything else that offers it should not each re-derive it
	 * from `openTabs` and disagree about what happens at the ends.
	 */
	focusAdjacentTab: (step: 1 | -1) => void;
	/**
	 * Go to the previous place in `navHistory` - and, for `goForward`, the next.
	 *
	 * A location whose tab is still open is focused; one whose tab was closed is
	 * reopened, which is what makes Back answer "put back what I just closed".
	 * Neither records a visit: they move the cursor, they do not extend the
	 * history, exactly as a browser's do.
	 */
	goBack: () => void;
	goForward: () => void;
}

/** Is there anywhere to go back to? Read by the buttons, the palette and the menu. */
export function canGoBack(state: Pick<TabsState, "navIndex">): boolean {
	return state.navIndex > 0;
}

/** Is there anywhere to go forward to? */
export function canGoForward(state: Pick<TabsState, "navHistory" | "navIndex">): boolean {
	return state.navIndex >= 0 && state.navIndex < state.navHistory.length - 1;
}

function sameLocation(a: TabLocation, b: TabLocation): boolean {
	return a.type === b.type && a.entityId === b.entityId;
}

/**
 * Is an activation happening *because* of Back or Forward?
 *
 * Those two navigate by calling `focusTab` / `openTab` - the same paths every
 * other navigation takes, deliberately, so a reopened tab is opened exactly the
 * way anything else opens it - and a recorded visit there would rewrite the
 * history the user is walking through: every Back would truncate the forward
 * half it had just created, and the stack would grow by one on every step
 * instead of the cursor moving through it.
 *
 * A module-level flag rather than a parameter threaded through both actions:
 * the store's actions are synchronous, so the window is one call, and every
 * caller of `openTab` would otherwise have to carry an argument that means
 * nothing to it.
 */
let traversingHistory = false;

/**
 * Record arriving at `location`, browser-style: coalesce a repeat of where we
 * already are, drop the forward half, append, and hold the cap.
 */
function recordVisit(
	history: TabLocation[],
	index: number,
	location: TabLocation
): Pick<TabsState, "navHistory" | "navIndex"> {
	if (traversingHistory) return { navHistory: history, navIndex: index };
	if (index >= 0 && sameLocation(history[index], location)) {
		return { navHistory: history, navIndex: index };
	}
	const next = [...history.slice(0, index + 1), location];
	const overflow = Math.max(0, next.length - MAX_NAV_HISTORY);
	return { navHistory: next.slice(overflow), navIndex: next.length - overflow - 1 };
}

/**
 * Drop every entry the predicate names, keeping the cursor on the same place -
 * or, when that place was one of the dropped ones, on the nearest surviving
 * entry behind it, and failing that the first one ahead.
 *
 * That last fallback is what keeps `-1` meaning one thing. It is reached when
 * everything at or before the cursor was deleted while places ahead survived,
 * and a `-1` there would say "nowhere" about a history that still holds open
 * tabs - after which the next recorded visit would truncate them as though they
 * were a forward half the user had left.
 */
function forgetLocations(
	history: TabLocation[],
	index: number,
	drop: (location: TabLocation) => boolean
): Pick<TabsState, "navHistory" | "navIndex"> {
	const kept: TabLocation[] = [];
	let nextIndex = -1;
	history.forEach((location, i) => {
		if (drop(location)) return;
		kept.push(location);
		if (i <= index) nextIndex = kept.length - 1;
	});
	if (nextIndex === -1 && kept.length > 0) nextIndex = 0;
	return { navHistory: kept, navIndex: nextIndex };
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

/**
 * Move the cursor one step and show what it lands on.
 *
 * The activation goes through `focusTab` / `openTab` rather than setting
 * `activeTabId` here, so a location arrived at by Back is opened exactly the way
 * it was opened the first time - the singleton dedupe, the LRU cap and the focus
 * stamp all apply, and there is no second definition of what showing a place
 * means. `traversingHistory` is what stops those calls from recording the step
 * as a new visit.
 */
function traverse(
	get: () => TabsState,
	set: (partial: Partial<TabsState>) => void,
	step: -1 | 1
): void {
	const { navHistory, navIndex } = get();
	const target = navIndex + step;
	if (target < 0 || target >= navHistory.length) return;

	const location = navHistory[target];
	set({ navIndex: target });
	traversingHistory = true;
	try {
		const open = get().openTabs.find((t) => sameLocation(t, location));
		if (open) get().focusTab(open.id);
		else get().openTab(location);
	} finally {
		traversingHistory = false;
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
			tabFocusedAt: {},
			specTabTarget: null,
			dataRowTarget: null,
			navHistory: [],
			navIndex: -1,

			openTab: (tabDef) => {
				const { openTabs, activeTabId, tabFocusedAt, navHistory, navIndex } = get();
				// One location for both branches below: a singleton that retargets
				// shows what was asked for, not what it was showing.
				const visited = recordVisit(navHistory, navIndex, {
					type: tabDef.type,
					entityId: tabDef.entityId,
				});

				// Dedupe: singletons and entity-keyed tabs
				const isSingleton = SINGLETON_TYPES.includes(tabDef.type);
				const existing = openTabs.find((t) =>
					isSingleton
						? t.type === tabDef.type
						: t.type === tabDef.type && t.entityId === tabDef.entityId
				);
				if (existing) {
					// Only a singleton can reach this branch with a different
					// entityId - the entity-keyed lookup above matched on it.
					const tabs =
						existing.entityId === tabDef.entityId
							? openTabs
							: openTabs.map((t) =>
									t.id === existing.id ? { ...t, entityId: tabDef.entityId } : t
								);
					set({
						openTabs: tabs,
						activeTabId: existing.id,
						tabFocusedAt: stampFocus(tabFocusedAt, tabs, existing.id),
						...visited,
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
					...visited,
				});
			},

			// The target is set before the tab opens, not after: opening focuses
			// the collection screen, which reads the target on that same render.
			openCollectionSpecTab: (collectionId) => {
				set({ specTabTarget: collectionId });
				get().openTab({ type: "collection", entityId: collectionId });
			},

			clearSpecTabTarget: () => set({ specTabTarget: null }),

			// Target first, tab second, for the reason `openCollectionSpecTab`
			// sets its own: opening focuses the builder, which reads the target on
			// that same render.
			openRequestWithDataRow: (requestId, rowIndex) => {
				if (!Number.isInteger(rowIndex) || rowIndex < 0) {
					throw new RangeError(
						`Cannot open a request at data row ${rowIndex} - a row index is a non-negative integer.`
					);
				}
				set({ dataRowTarget: { requestId, rowIndex } });
				get().openTab({ type: "request", entityId: requestId });
			},

			clearDataRowTarget: () => set({ dataRowTarget: null }),

			closeTab: (tabId) => {
				const { openTabs, activeTabId, navHistory, navIndex } = get();
				const idx = openTabs.findIndex((t) => t.id === tabId);
				if (idx === -1) return;

				const remaining = openTabs.filter((t) => t.id !== tabId);

				if (activeTabId !== tabId) {
					set({ openTabs: remaining });
					return;
				}

				/*
				 * The active tab is going, so something has to take its place, and
				 * the history is what knows where the user came from - which is where
				 * a browser lands you when you close the page you are on (#1245). The
				 * strip's left neighbour is the fallback, not the rule: it is the
				 * answer to "which tab is beside this one", and the user asked to
				 * leave, not to move one step left.
				 *
				 * The cursor lands on that earlier entry rather than dropping the
				 * ones it passed, so the closed tab stays ahead of it: Forward
				 * reopens what was just closed, for free and by the same rule Back
				 * reopens anything else.
				 */
				for (let i = navIndex - 1; i >= 0; i--) {
					const open = remaining.find((t) => sameLocation(t, navHistory[i]));
					if (open) {
						set({ openTabs: remaining, activeTabId: open.id, navIndex: i });
						return;
					}
				}

				/*
				 * Nothing behind is open, so the strip's own rule answers: the tab
				 * to the left, or the new last tab.
				 *
				 * Recorded as a visit, because the user is now somewhere the history
				 * did not send them. The cursor always names where they are - the
				 * invariant every other path here holds - and the place just closed
				 * stays behind it, so Back is what reopens it.
				 */
				const newFocus = remaining[Math.max(0, idx - 1)];
				if (!newFocus) {
					set({ openTabs: remaining, activeTabId: null });
					return;
				}
				set({
					openTabs: remaining,
					activeTabId: newFocus.id,
					...recordVisit(navHistory, navIndex, {
						type: newFocus.type,
						entityId: newFocus.entityId,
					}),
				});
			},

			closeTabsForEntities: (entityIds, type) => {
				const ids = new Set(entityIds);
				if (ids.size === 0) return;

				// A delete that can name a request takes its response with it: the
				// collection tree reaches here after deleting a request or a whole
				// collection, and each entry holds a body plus its raw copy. The
				// map's own LRU bound (#1156) only puts a ceiling on the session -
				// a response nothing can reach again should go now, not in
				// twenty-four sends' time. Skipped for a `type`-scoped sweep
				// that is not about requests - `"run"` ids cannot key a response, so
				// walking them would only look like it meant something. Done before
				// the early return below, since a deleted request with no open tab
				// still leaves a response behind.
				if (type === undefined || type === "request") {
					const { clearResponse } = useResponseStore.getState();
					for (const id of ids) clearResponse(id);
				}

				const { openTabs, activeTabId, navHistory, navIndex } = get();
				const shouldClose = (t: TabLocation) =>
					t.entityId !== null &&
					ids.has(t.entityId) &&
					(type === undefined || t.type === type);

				/*
				 * A deleted entity leaves the history too, and this is the moment it
				 * can: deletion is the one point where the app knows an entity is
				 * gone, everywhere else finding out lazily from a 404 when a pane
				 * renders. Pruning here is what makes Back never land on a request
				 * that no longer exists - it is not there to land on - rather than
				 * reopening a tab whose only content is an error.
				 *
				 * Before the early return below: an entity with no open tab can
				 * still be somewhere the user has been.
				 */
				const forgotten = forgetLocations(navHistory, navIndex, shouldClose);

				const remaining = openTabs.filter((t) => !shouldClose(t));
				if (remaining.length === openTabs.length) {
					set(forgotten);
					return; // no tab matched
				}

				let nextActiveId = activeTabId;
				let navigation = forgotten;
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
					/*
					 * The survivor is where the user now is, so the history says so -
					 * the same invariant `closeTab` holds. `recordVisit` coalesces when
					 * the pruned cursor already names it, which is the usual case: the
					 * survivor is normally somewhere they have been.
					 */
					if (pick) {
						navigation = recordVisit(forgotten.navHistory, forgotten.navIndex, {
							type: pick.type,
							entityId: pick.entityId,
						});
					}
				}

				set({ openTabs: remaining, activeTabId: nextActiveId, ...navigation });
			},

			focusTab: (tabId) => {
				const { openTabs, tabFocusedAt, navHistory, navIndex } = get();
				const tab = openTabs.find((t) => t.id === tabId);
				if (tab) {
					set({
						activeTabId: tabId,
						tabFocusedAt: stampFocus(tabFocusedAt, openTabs, tabId),
						...recordVisit(navHistory, navIndex, {
							type: tab.type,
							entityId: tab.entityId,
						}),
					});
				}
			},

			goBack: () => traverse(get, set, -1),
			goForward: () => traverse(get, set, 1),

			focusAdjacentTab: (step) => {
				const { openTabs, activeTabId } = get();
				if (openTabs.length === 0) return;
				/*
				 * `openTabs` order, not `tabFocusedAt` order: "next" means the tab
				 * to the right of this one in the strip, which is what the user is
				 * looking at. The recency stamps answer a different question, and
				 * the palette is where they are asked.
				 */
				const current = openTabs.findIndex((t) => t.id === activeTabId);
				// With no active tab, forwards starts at the first and backwards at
				// the last - the same wrap, entered from outside.
				const next =
					current === -1
						? step === 1
							? 0
							: openTabs.length - 1
						: (current + step + openTabs.length) % openTabs.length;
				get().focusTab(openTabs[next].id);
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
