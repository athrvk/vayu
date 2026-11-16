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
import { useTabSelectionStore } from "./tab-selection-store";
import { useEntityDraftStore } from "./entity-draft-store";
import { selectKnownEngineStatus, useEngineStore } from "./engine-store";
import { useToastStore } from "./toast-store";
import { pluralize } from "@/modules/dashboard/utils/format";

export type TabType =
	| "welcome"
	| "request"
	| "collection"
	| "dashboard"
	| "run"
	| "variables"
	| "settings"
	| "inbox"
	| "mock-server";

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
 * What a navigation asks of the screen it opens, beyond which tab to show.
 * `target` is the id of the entity the intent is for (collection, request or
 * run), and the matching tab is `intentTab`.
 */
export type NavIntent =
	| { kind: "spec"; target: string }
	| { kind: "dataRow"; target: string; rowIndex: number }
	| { kind: "compare"; target: string }
	| { kind: "focusUrl"; target: string };

const INTENT_TAB_TYPE: Record<NavIntent["kind"], TabType> = {
	spec: "collection",
	dataRow: "request",
	compare: "run",
	focusUrl: "request",
};

function intentTab(intent: NavIntent): TabLocation {
	return { type: INTENT_TAB_TYPE[intent.kind], entityId: intent.target };
}

/** The intent, if the tab it names is still among `tabs`; otherwise `null`. */
function intentIfOpen(intent: NavIntent | null, tabs: readonly Tab[]): NavIntent | null {
	if (!intent) return null;
	const named = intentTab(intent);
	return tabs.some((t) => sameLocation(t, named)) ? intent : null;
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
const SINGLETON_TYPES: TabType[] = ["welcome", "variables", "settings", "inbox", "mock-server"];

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
	 * it was opened - and by `openTab`'s LRU eviction, which takes the least
	 * recently focused clean tab. Both read it, so every path that makes a tab
	 * active stamps it, a close that activates a survivor included.
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
	 * The one in-flight hand-off from a navigation to the screen it opened, or
	 * `null` (issues #680, #730, #2164, #3355, #3400).
	 *
	 * `openTab` can only name a tab, and four navigations need to say more: which
	 * sub-tab a collection opens on (`spec`), which data row a request's Send binds
	 * (`dataRow`), whether a run's report opens on its comparison (`compare`), and
	 * whether a request opens with its URL field focused (`focusUrl`).
	 * That state lives in the destination screen, so the navigation leaves a
	 * `NavIntent` here and the screen takes it with `takeNavIntent`, once.
	 *
	 * It belongs to the navigation that issued it, not to the entity it names. Every
	 * activation that does not itself issue one (`openTab`, `focusTab`, `goBack`,
	 * `goForward`, `focusAdjacentTab`) clears it, and so does closing the tab it
	 * names, so a screen that never mounted to take it cannot fire it on a later
	 * visit. A consumer that finds nothing for its own kind and target does nothing.
	 *
	 * Session-scoped (absent from `partialize`): it is one navigation in flight, and
	 * a persisted copy would jump a user to a Spec tab, a data row or a comparison
	 * for a choice made in a previous launch. A data row in particular points into a
	 * file whose rows are deliberately never persisted.
	 */
	navIntent: NavIntent | null;
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
	/** Show a collection, on its Spec tab - a `spec` intent. */
	openCollectionSpecTab: (collectionId: string) => void;
	/**
	 * Show a request, with one row of its collection's data file selected for
	 * Send-with-row - a `dataRow` intent.
	 *
	 * A negative or non-integer index is refused rather than stored: it can only
	 * come from a malformed trace, and a picker asked to select row -1 would
	 * open on nothing with no way to tell that from a file that failed to read.
	 */
	openRequestWithDataRow: (requestId: string, rowIndex: number) => void;
	/** Show a load run's report on its comparison view - a `compare` intent. */
	openRunComparison: (runId: string) => void;
	/**
	 * Show a request with the caret in its URL field - a `focusUrl` intent. For a
	 * request just created blank, where the next thing the user does is type.
	 */
	openRequestFocusingUrl: (requestId: string) => void;
	/**
	 * Take the pending intent if it is of this `kind` and names `target`, clearing
	 * it; `null` and no change otherwise. The screen that owns the target calls
	 * this once it renders for it, whether or not it can act on what it gets.
	 */
	takeNavIntent: <K extends NavIntent["kind"]>(
		kind: K,
		target: string
	) => Extract<NavIntent, { kind: K }> | null;
	closeTab: (tabId: string) => void;
	/**
	 * Close every tab except one - the strip's "Close Others".
	 *
	 * A bulk close is one close, not a loop of closes: it removes the whole set
	 * in a single `set`, and records at most one visit for wherever the user
	 * ends up. Closing them one at a time would record a visit per tab and walk
	 * the user through a history of places they never went.
	 */
	closeOtherTabs: (tabId: string) => void;
	/** Close every tab after this one in the strip. Nothing to its left moves. */
	closeTabsToRight: (tabId: string) => void;
	/**
	 * Put `tabId` at `toIndex` in the strip, the index it occupies afterwards,
	 * clamped to the list. Reorders `openTabs` only: the active tab, the focus
	 * stamps and the navigation history name tabs by id and location, never by
	 * position, so none of them changes. The `Tab` objects are reused, not
	 * copied: `tabItemPropsEqual` compares `prev.tab === next.tab`.
	 */
	moveTab: (tabId: string, toIndex: number) => void;
	/**
	 * Close every tab that holds no unsaved edits, keeping the dirty ones.
	 *
	 * "Saved" is `isTabDirty` read backwards - the same answer that decides
	 * which tab LRU eviction may take - so the one definition of a dirty tab
	 * serves both, and a tab type that learns to be dirty is covered here for
	 * free.
	 */
	closeSavedTabs: () => void;
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
 * Drops the dirty tabs from a bulk close while the engine cannot take a save
 * (#3324), and says once how many stayed.
 *
 * `closeTab` refuses a dirty tab for the same reason (#1489): the unmount flush
 * would fail into a pane that no longer exists. A bulk close that skipped the
 * check would discard exactly those edits, so the clean tabs close and the
 * dirty ones are held back. `closeSavedTabs` needs none of this - it never
 * selects a dirty tab.
 */
function withoutUnsavableTabs(openTabs: readonly Tab[], closing: ReadonlySet<string>) {
	if (selectKnownEngineStatus(useEngineStore.getState()) === "connected") return closing;
	const contexts = useSaveStore.getState().contexts;
	const kept = new Set(
		openTabs.filter((t) => closing.has(t.id) && isTabDirty(t, contexts)).map((t) => t.id)
	);
	if (kept.size === 0) return closing;
	useToastStore
		.getState()
		.showToast(
			`Not saved - Vayu's engine is unreachable; kept ${kept.size} unsaved ${pluralize(kept.size, "tab")} open`,
			"error"
		);
	return new Set([...closing].filter((id) => !kept.has(id)));
}

/**
 * Remove every tab the id set names, and answer where that leaves the user.
 *
 * One function behind every close in this store, because "which tab takes the
 * place of the one that was showing" is a single rule in three parts - the
 * nearest still-open place behind the cursor, then the neighbour to the left,
 * then the one to the right - and a second copy of it would answer a bulk close
 * differently from a single one.
 *
 * A bulk close is one close, not a loop of them: the whole set goes in one
 * `set` and at most one visit is recorded. Calling `closeTab` per tab would
 * record a visit for every intermediate tab it focused on the way, leaving Back
 * to walk the user through places they never went.
 *
 * `null` means nothing matched, so the caller leaves the store untouched rather
 * than publishing an identical state.
 *
 * The history itself is left alone. A closed tab is still somewhere the user has
 * been, and Back is what puts it back (#1245); only a *deleted* entity leaves
 * the history, which is `closeTabsForEntities`' own concern. A pending
 * `navIntent` is the opposite: it goes with the tab it names.
 */
function closeTabs(
	state: Pick<
		TabsState,
		"openTabs" | "activeTabId" | "tabFocusedAt" | "navHistory" | "navIndex" | "navIntent"
	>,
	closing: ReadonlySet<string>
): Partial<TabsState> | null {
	const { openTabs, activeTabId, tabFocusedAt, navHistory, navIndex } = state;
	const remaining = openTabs.filter((t) => !closing.has(t.id));
	if (remaining.length === openTabs.length) return null;
	const navIntent = intentIfOpen(state.navIntent, remaining);

	// The tab in view is staying, so nothing has to take its place.
	const activeIndex = openTabs.findIndex((t) => t.id === activeTabId);
	if (activeIndex === -1 || !closing.has(openTabs[activeIndex].id)) {
		return { openTabs: remaining, navIntent };
	}

	/*
	 * The active tab is going, and the history is what knows where the user came
	 * from - which is where a browser lands you when you close the page you are
	 * on. The cursor lands on that earlier entry rather than dropping the ones it
	 * passed, so the closed tabs stay ahead of it and Forward reopens them.
	 */
	for (let i = navIndex - 1; i >= 0; i--) {
		const open = remaining.find((t) => sameLocation(t, navHistory[i]));
		if (open) {
			return {
				openTabs: remaining,
				activeTabId: open.id,
				tabFocusedAt: stampFocus(tabFocusedAt, remaining, open.id),
				navIndex: i,
				navIntent,
			};
		}
	}

	/*
	 * Nothing behind is open, so the strip's own rule answers: the nearest tab
	 * that is staying, preferring the left.
	 *
	 * Recorded as a visit, because the user is now somewhere the history did not
	 * send them. The cursor always names where they are - the invariant every
	 * other path here holds - and what was just closed stays behind it.
	 */
	const survivor = nearestSurvivor(openTabs, activeIndex, closing);
	if (!survivor) return { openTabs: remaining, activeTabId: null, navIntent };
	return {
		openTabs: remaining,
		activeTabId: survivor.id,
		navIntent,
		tabFocusedAt: stampFocus(tabFocusedAt, remaining, survivor.id),
		...recordVisit(navHistory, navIndex, {
			type: survivor.type,
			entityId: survivor.entityId,
		}),
	};
}

/**
 * Closes the tabs and throws away the collection drafts they held (#3459). A
 * stored draft outlives its editor only while its tab is open: once the tab is
 * gone nothing can show the draft again, and its context must not save it on
 * quit.
 */
function closeTabsNow(
	get: () => TabsState,
	set: (partial: Partial<TabsState>) => void,
	closing: ReadonlySet<string>
): void {
	const before = get().openTabs;
	const next = closeTabs(get(), closing);
	if (!next) return;
	set(next);
	forgetDrafts(before.filter((t) => closing.has(t.id)));
}

function forgetDrafts(closed: readonly Tab[]): void {
	const ids = closed.flatMap((t) =>
		t.type === "collection" && t.entityId !== null ? [t.entityId] : []
	);
	if (ids.length > 0) useEntityDraftStore.getState().dropForEntities(ids);
}

/** The tab nearest `index` that is staying open, preferring the one to the left. */
function nearestSurvivor(
	tabs: Tab[],
	index: number,
	closing: ReadonlySet<string>
): Tab | undefined {
	for (let i = index - 1; i >= 0; i--) {
		if (!closing.has(tabs[i].id)) return tabs[i];
	}
	for (let i = index + 1; i < tabs.length; i++) {
		if (!closing.has(tabs[i].id)) return tabs[i];
	}
	return undefined;
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
 * `-elements` (`useDraftSaveContext`). Matching
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
		case "mock-server":
			// Same reasoning as "inbox": a mock's route table and activity log
			// are engine state with no draft of this tab's own.
			return false;
		// welcome, dashboard and run register no save context at all.
		default:
			return false;
	}
}

/**
 * Index of the tab LRU eviction takes: the least recently focused one that is
 * safe to lose, or `-1` when none is.
 *
 * Safe means not on screen, not exempt and clean. The tab being opened is never
 * a candidate - it has no stamp, so it would rank first, and dropping it would
 * leave `activeTabId` naming a tab that is not there. When every other tab is
 * dirty the strip therefore runs past the cap rather than losing work.
 *
 * A tab with no stamp (restored this session, never focused) ranks as `0`, so it
 * goes before any tab the user has actually used. Ties keep strip order, the
 * earlier tab first.
 */
function leastRecentlyFocusedIndex(
	tabs: Tab[],
	openingId: string,
	activeTabId: string | null,
	tabFocusedAt: Record<string, number>,
	contexts: Map<string, SaveContext>
): number {
	let evictIndex = -1;
	let evictStamp = Infinity;
	tabs.forEach((t, i) => {
		if (t.id === openingId || t.id === activeTabId) return;
		if (LRU_EXEMPT_TYPES.includes(t.type)) return;
		if (isTabDirty(t, contexts)) return;
		const stamp = tabFocusedAt[t.id] ?? 0;
		if (stamp >= evictStamp) return;
		evictIndex = i;
		evictStamp = stamp;
	});
	return evictIndex;
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
 * Every path that makes a tab active calls this, the close paths included: a
 * tab a close brings on screen is being focused, and eviction ranks by the
 * stamp. Pruning here rather than in the close branches that activate nothing
 * is what keeps those unchanged: a stamp for a closed tab is unreachable
 * (nothing ranks a tab that is not open) and is dropped the next time anything
 * is focused.
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

/**
 * Show a tab, opening it if it is not already open, and leave `intent` pending
 * for the screen it lands on - or clear whatever was pending when there is none.
 *
 * One `set` for the tab and the intent together: the destination screen reads
 * the intent on the very render the tab becomes active, and an intent set in a
 * separate step would either miss that render or be cleared by this activation.
 * Every other path that makes a tab active clears the intent instead (`openTab`
 * through here with `null`, `focusTab` directly), which is what ends one whose
 * screen never took it.
 */
function activateTab(
	get: () => TabsState,
	set: (partial: Partial<TabsState>) => void,
	tabDef: Omit<Tab, "id">,
	intent: NavIntent | null
): void {
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
			navIntent: intent,
			...visited,
		});
		return;
	}

	const newTab: Tab = { ...tabDef, id: makeId() };
	const tabs = [...openTabs, newTab];
	const evicted: Tab[] = [];

	// LRU eviction when over cap. Nothing is flushed on the way out:
	// the selector refuses a dirty tab, so there is no flush to run -
	// and had there been one, `void ctx.save()` would have dropped the
	// rejection. Eviction simply never takes unsaved work.
	if (tabs.length > MAX_OPEN_TABS) {
		const evictIndex = leastRecentlyFocusedIndex(
			tabs,
			newTab.id,
			activeTabId,
			tabFocusedAt,
			useSaveStore.getState().contexts
		);
		if (evictIndex !== -1) evicted.push(...tabs.splice(evictIndex, 1));
	}

	set({
		openTabs: tabs,
		activeTabId: newTab.id,
		tabFocusedAt: stampFocus(tabFocusedAt, tabs, newTab.id),
		navIntent: intent,
		...visited,
	});
	forgetDrafts(evicted);
}

export const useTabsStore = create<TabsState>()(
	persist(
		(set, get) => ({
			openTabs: [],
			activeTabId: null,
			tabFocusedAt: {},
			navIntent: null,
			navHistory: [],
			navIndex: -1,

			openTab: (tabDef) => activateTab(get, set, tabDef, null),

			openCollectionSpecTab: (collectionId) =>
				activateTab(
					get,
					set,
					{ type: "collection", entityId: collectionId },
					{ kind: "spec", target: collectionId }
				),

			openRequestWithDataRow: (requestId, rowIndex) => {
				if (!Number.isInteger(rowIndex) || rowIndex < 0) {
					throw new RangeError(
						`Cannot open a request at data row ${rowIndex} - a row index is a non-negative integer.`
					);
				}
				activateTab(
					get,
					set,
					{ type: "request", entityId: requestId },
					{ kind: "dataRow", target: requestId, rowIndex }
				);
			},

			openRunComparison: (runId) =>
				activateTab(
					get,
					set,
					{ type: "run", entityId: runId },
					{ kind: "compare", target: runId }
				),

			openRequestFocusingUrl: (requestId) =>
				activateTab(
					get,
					set,
					{ type: "request", entityId: requestId },
					{ kind: "focusUrl", target: requestId }
				),

			takeNavIntent: (kind, target) => {
				const intent = get().navIntent;
				if (intent?.kind !== kind || intent.target !== target) return null;
				set({ navIntent: null });
				return intent as Extract<NavIntent, { kind: typeof kind }>;
			},

			// A dirty tab with nowhere for its unmount flush to land is a silent
			// loss (#1489): `useSaveManager`'s cleanup fires the save anyway, its
			// failure toast lands in a pane that no longer exists, and the eviction
			// guard above only ever protected LRU, not an explicit close. Held here
			// instead, before the tab (and the editor holding the draft) is gone.
			closeTab: (tabId) => {
				const tab = get().openTabs.find((t) => t.id === tabId);
				if (
					tab &&
					isTabDirty(tab, useSaveStore.getState().contexts) &&
					selectKnownEngineStatus(useEngineStore.getState()) !== "connected"
				) {
					useToastStore
						.getState()
						.showToast("Not saved - Vayu's engine is unreachable", "error");
					return;
				}
				closeTabsNow(get, set, new Set([tabId]));
			},

			closeOtherTabs: (tabId) => {
				const { openTabs } = get();
				if (!openTabs.some((t) => t.id === tabId)) return;
				const closing = withoutUnsavableTabs(
					openTabs,
					new Set(openTabs.filter((t) => t.id !== tabId).map((t) => t.id))
				);
				closeTabsNow(get, set, closing);
			},

			closeTabsToRight: (tabId) => {
				const { openTabs } = get();
				const index = openTabs.findIndex((t) => t.id === tabId);
				if (index === -1) return;
				const closing = withoutUnsavableTabs(
					openTabs,
					new Set(openTabs.slice(index + 1).map((t) => t.id))
				);
				closeTabsNow(get, set, closing);
			},

			moveTab: (tabId, toIndex) => {
				const { openTabs } = get();
				const fromIndex = openTabs.findIndex((t) => t.id === tabId);
				if (fromIndex === -1) return;
				const to = Math.max(0, Math.min(Math.trunc(toIndex), openTabs.length - 1));
				if (to === fromIndex) return;
				const next = openTabs.filter((t) => t.id !== tabId);
				next.splice(to, 0, openTabs[fromIndex]);
				set({ openTabs: next });
			},

			closeSavedTabs: () => {
				const contexts = useSaveStore.getState().contexts;
				const closing = new Set(
					get()
						.openTabs.filter((t) => !isTabDirty(t, contexts))
						.map((t) => t.id)
				);
				closeTabsNow(get, set, closing);
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

				// A deleted request or collection's remembered sub-tab goes with it
				// too - unlike the response above, this runs for every `type`: a
				// collection id keys `collectionTab` the same way a request id keys
				// `requestTab`/`responseTab`, and `clearEntity` is a harmless no-op
				// for whichever of the four maps never held the id.
				const { clearEntity } = useTabSelectionStore.getState();
				for (const id of ids) clearEntity(id);
				// And so does any unsaved draft it held, descendants' included: the
				// caller passes the whole subtree. `markRemoved` cannot stand in for
				// this - its ids are request-scoped - and a draft left behind would
				// send its save at the deleted row on quit.
				useEntityDraftStore.getState().dropForEntities(ids);

				const { openTabs, activeTabId, tabFocusedAt, navHistory, navIndex, navIntent } =
					get();
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
				let navigation: Partial<TabsState> = forgotten;
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
						navigation = {
							...recordVisit(forgotten.navHistory, forgotten.navIndex, {
								type: pick.type,
								entityId: pick.entityId,
							}),
							tabFocusedAt: stampFocus(tabFocusedAt, remaining, pick.id),
						};
					}
				}

				set({
					openTabs: remaining,
					activeTabId: nextActiveId,
					navIntent: intentIfOpen(navIntent, remaining),
					...navigation,
				});
			},

			focusTab: (tabId) => {
				const { openTabs, tabFocusedAt, navHistory, navIndex } = get();
				const tab = openTabs.find((t) => t.id === tabId);
				if (tab) {
					set({
						activeTabId: tabId,
						tabFocusedAt: stampFocus(tabFocusedAt, openTabs, tabId),
						navIntent: null,
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
