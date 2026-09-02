/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { lazy, Suspense, useEffect, useState } from "react";
import {
	useTabsStore,
	useSaveStore,
	useLayoutStore,
	type Tab,
	type TabType,
	type DrawerView,
} from "@/stores";
import { isModalOpen } from "@/lib/modal";
import type { Chord } from "@/lib/platform";
import {
	SAVE_CHORD,
	CLOSE_TAB_CHORD,
	TOGGLE_DRAWER_CHORD,
	TOGGLE_CONTEXT_BAR_CHORD,
	SETTINGS_CHORD,
	NEW_REQUEST_CHORD,
	FOCUS_URL_CHORD,
	NEXT_TAB_CHORD,
	PREVIOUS_TAB_CHORD,
	NEXT_REGION_CHORD,
	PREVIOUS_REGION_CHORD,
	DRAWER_VIEW_CHORDS,
	TAB_CHORDS,
	matchesChord,
} from "@/constants/shortcuts";
import { useNewRequest } from "@/hooks/useNewRequest";
import { ImportModal } from "@/modules/collections/ImportModal";
import { CollectionPicker } from "@/modules/welcome/components/CollectionPicker";
import { Drawer } from "./Drawer";
import { Dock } from "./Dock";
import { ContextBar } from "./ContextBar";
import { TabStrip } from "./TabStrip";
import { tabElementId, tabPanelElementId } from "./tab-aria";
import { closeTabFromKeyboard } from "./tab-focus";
import { cycleRegionFocus, focusRequestUrl, type AppRegion } from "./region-focus";
import { CommandPalette } from "@/modules/palette";
import { DetailSkeleton } from "@/components/shared/DetailSkeleton";
import RequestBuilder from "@/modules/request-builder";

/*
 * One tab's surface is mounted at a time, so every surface but the one on
 * screen was 5.5MB of module graph parsed before the window could appear
 * (#1146). Each is its own chunk now, fetched when its tab is first opened.
 *
 * RequestBuilder stays eager: it is what the app opens into for anyone with a
 * request tab restored, so deferring it would trade paint time for a skeleton
 * on the surface most likely to be first.
 */
const CollectionDetail = lazy(() => import("@/modules/collections/CollectionDetail"));
const LoadTestDashboard = lazy(() => import("@/modules/dashboard"));
/*
 * Both of these are the component's own file rather than its module barrel,
 * and that is what makes them split at all: a barrel is one module, so
 * `@/modules/settings` would be pulled in eagerly anyway by `Drawer`'s
 * `SettingsCategoryTree` import - and the Drawer is mounted on every tab.
 */
const HistoryDetail = lazy(() => import("@/modules/history/main/HistoryDetail"));
const WelcomeScreen = lazy(() => import("@/modules/welcome/WelcomeScreen"));
const SettingsMain = lazy(() => import("@/modules/settings/main/SettingsMain"));
const VariablesMain = lazy(() => import("@/modules/variables/main/VariablesMain"));
const InboxView = lazy(() => import("@/modules/inbox"));

/**
 * What the skeleton says while a surface's chunk loads. Named per tab type
 * rather than a bare "Loading" - which pane is arriving is the one thing the
 * placeholder knows and a screen reader cannot see.
 */
const LOADING_LABEL: Record<TabType, string> = {
	welcome: "Loading welcome screen",
	request: "Loading request",
	collection: "Loading collection",
	dashboard: "Loading load test dashboard",
	run: "Loading run",
	variables: "Loading variables",
	settings: "Loading settings",
	inbox: "Loading inbox",
};

function renderTabContent(tab: Tab | null): React.ReactNode {
	if (!tab) return <WelcomeScreen />;
	switch (tab.type) {
		case "welcome":
			return <WelcomeScreen />;
		case "request":
			return tab.entityId ? <RequestBuilder /> : <WelcomeScreen />;
		case "collection":
			return tab.entityId ? <CollectionDetail /> : null;
		case "dashboard":
			return <LoadTestDashboard />;
		case "run":
			return tab.entityId ? <HistoryDetail /> : null;
		case "variables":
			return <VariablesMain />;
		case "settings":
			return <SettingsMain />;
		case "inbox":
			return <InboxView />;
		default:
			return null;
	}
}

/**
 * Which way this key cycles the window's regions, or `null` when it is not
 * either region chord.
 *
 * Outside the component and asked before the handler's modifier gate, because
 * F6 is the one chord in the map that carries no ⌘ or Ctrl.
 */
function regionStep(e: KeyboardEvent): 1 | -1 | null {
	if (matchesChord(e, NEXT_REGION_CHORD)) return 1;
	if (matchesChord(e, PREVIOUS_REGION_CHORD)) return -1;
	return null;
}

export default function Shell() {
	const { openTabs, activeTabId, focusTab, focusAdjacentTab, openTab } = useTabsStore();
	/*
	 * The Shell hosts the new-request flow for its ⌘N chord, and the palette
	 * hosts its own for the "New request" command. Two hosts of one hook, not
	 * two flows: `useNewRequest` is written to be mounted more than once ("each
	 * caller renders its own from `pickerProps`, so two surfaces never fight
	 * over one dialog's open state"), and both reach the same creation path.
	 */
	const { newRequest, pickerProps } = useNewRequest();
	const { toggleDrawer, activateDrawerView, toggleContextBar, setDrawerOpen, setDrawerView } =
		useLayoutStore();
	const { triggerSave } = useSaveStore();
	const [windowWidth, setWindowWidth] = useState(window.innerWidth);

	useEffect(() => {
		const onResize = () => setWindowWidth(window.innerWidth);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	const activeTab = openTabs.find((t) => t.id === activeTabId) ?? null;

	// Auto-open the matching drawer view when navigating to a tab whose entity
	// lives in a drawer (collections tree for requests/collections, variables list).
	useEffect(() => {
		if (activeTab?.type === "variables") {
			setDrawerOpen(true);
			setDrawerView("variables");
		} else if (activeTab?.type === "settings") {
			setDrawerOpen(true);
			setDrawerView("settings");
		} else if (activeTab?.type === "collection" || activeTab?.type === "request") {
			setDrawerOpen(true);
			setDrawerView("collections");
		} else if (activeTab?.type === "run") {
			/*
			 * A run's list is History, so a run tab belongs with it - and with the
			 * drawer open. It had no branch at all, which was not quite the same as
			 * "leave it alone": the drawer never *opened*, so picking a run while it
			 * was closed left the sidebar shut.
			 *
			 * The guard this has to respect is the older bug where opening a run
			 * threw the user out of the History list. Selecting History satisfies
			 * that rather than violating it - the failure then was landing
			 * somewhere else.
			 */
			setDrawerOpen(true);
			setDrawerView("history");
		} else if (activeTab?.type === "dashboard") {
			/*
			 * Deliberately nothing. Written out rather than left to fall off the
			 * end, because "no branch" is what made the `run` case a bug for so
			 * long - it is indistinguishable from nobody having considered it, and
			 * the next person adding branches for completeness would add one here.
			 *
			 * The dashboard is a detour from a request, not a list item: it is
			 * opened only by the request builder when a load test starts, carries
			 * `entityId: null`, and its back button returns to `sourceRequestId`
			 * rather than closing. So when it opens, the drawer is already on
			 * Collections with that request revealed - which is both where the user
			 * came from and where Back sends them. Switching to History would
			 * discard exactly that context, twice per round trip.
			 *
			 * A judgement call, not a forced one: a running test *does* appear in
			 * History (`listRuns` applies no status filter, and the sidebar offers
			 * a "Running" filter), so showing History here would not be
			 * nonsensical - just contrary to the flow.
			 */
		}
	}, [activeTab?.type, activeTab?.entityId, setDrawerOpen, setDrawerView]);

	useEffect(() => {
		/*
		 * Every chord here is a definition in `constants/shortcuts.ts`, matched by
		 * `matchesChord` - the same registry the Dock's tooltips advertise from
		 * and the same matcher the Send/Load Test handler uses (#938).
		 *
		 * It was fourteen hand-rolled comparisons against `e.key` behind a raw
		 * `e.metaKey || e.ctrlKey`, and the two bugs that cost were both things
		 * the registry has always compared and the hand-rolled map did not:
		 * `altKey` (so Ctrl+Alt+S, which is AltGr+S on many European Windows
		 * layouts, saved) and the layout-independence of the digit row (⌘1-9 was
		 * dead on AZERTY, whose unshifted digits produce `&é"'(-è_çà`).
		 */
		const handleKeyDown = (e: KeyboardEvent) => {
			// F6 and ⇧F6 are the only chords here without the primary modifier, so
			// they are settled before the gate that lets every other key go by
			// untouched - the gate is what keeps this listener off the typing path.
			const region = regionStep(e);
			if (region === null && !(e.metaKey || e.ctrlKey)) return;
			/*
			 * Nothing here acts while a modal is up (#935). Every chord below
			 * moves or destroys the thing the dialog is attached to - ⌘W closed
			 * the tab underneath it, ⌘1-9 switched away from it - so the dialog's
			 * owner unmounted mid-interaction and the dialog went with it.
			 *
			 * Escape closes the dialog first; then the chords are live again. The
			 * command palette is itself a dialog, so its own ⌘K listener keeps
			 * working (it is bound in `CommandPalette`, not here) while nothing
			 * else does - which is what a palette on top of the window should do.
			 */
			if (isModalOpen()) return;

			if (region !== null) {
				e.preventDefault();
				cycleRegionFocus(region);
				return;
			}
			if (matchesChord(e, NEW_REQUEST_CHORD)) {
				e.preventDefault();
				newRequest();
				return;
			}
			if (matchesChord(e, FOCUS_URL_CHORD)) {
				e.preventDefault();
				focusRequestUrl();
				return;
			}
			if (matchesChord(e, NEXT_TAB_CHORD)) {
				e.preventDefault();
				focusAdjacentTab(1);
				return;
			}
			if (matchesChord(e, PREVIOUS_TAB_CHORD)) {
				e.preventDefault();
				focusAdjacentTab(-1);
				return;
			}
			if (matchesChord(e, SAVE_CHORD)) {
				e.preventDefault();
				triggerSave();
				return;
			}
			if (matchesChord(e, CLOSE_TAB_CHORD)) {
				e.preventDefault();
				// The chord fires from wherever focus is, and what it closes is
				// usually what holds it - the panel this tab renders. Focus moves
				// to the tab that replaces it rather than to `<body>` (#1218).
				if (activeTabId) closeTabFromKeyboard(activeTabId);
				return;
			}
			if (matchesChord(e, TOGGLE_DRAWER_CHORD)) {
				e.preventDefault();
				toggleDrawer();
				return;
			}
			if (matchesChord(e, TOGGLE_CONTEXT_BAR_CHORD)) {
				e.preventDefault();
				toggleContextBar();
				return;
			}
			if (matchesChord(e, SETTINGS_CHORD)) {
				e.preventDefault();
				openTab({ type: "settings", entityId: null });
				return;
			}

			// The drawer switchers, from the same table the Dock's tooltips read.
			// Settings is in that table too and is handled above, by the chord it
			// shares - opening the tab, which brings its drawer view with it.
			for (const [view, chord] of Object.entries(DRAWER_VIEW_CHORDS) as [
				DrawerView,
				Chord,
			][]) {
				if (matchesChord(e, chord)) {
					e.preventDefault();
					activateDrawerView(view);
					return;
				}
			}

			const tabIndex = TAB_CHORDS.findIndex((chord) => matchesChord(e, chord));
			if (tabIndex !== -1) {
				const tab = openTabs[tabIndex];
				if (tab) {
					e.preventDefault();
					focusTab(tab.id);
				}
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [
		triggerSave,
		toggleDrawer,
		toggleContextBar,
		activateDrawerView,
		openTab,
		focusTab,
		focusAdjacentTab,
		newRequest,
		activeTabId,
		openTabs,
	]);

	return (
		<div className="flex flex-col h-full bg-background overflow-hidden">
			<ImportModal />
			{/* Mounted once, like the import modal: it is summoned from a chord
			    rather than from anything on screen, and its own ⌘K listener is
			    what opens it. It owns that chord rather than the keydown map
			    below - see the capture-phase note in CommandPalette. */}
			<CommandPalette />
			{/* The picker for ⌘N, on the same terms as the modals above: mounted
			    once, shows nothing until the flow asks where a request should
			    land. The palette renders its own from the same hook. */}
			<CollectionPicker {...pickerProps} />
			{/* Every tab uses the same shell: one left Drawer (its view switches
			    with the tab - collections/history/variables/settings), the main
			    content, and the request-only ContextBar. No tab type takes over
			    the row, so the Dock's drawer switchers always have a Drawer to act
			    on. */}
			<div className="flex flex-1 overflow-hidden">
				<Drawer />
				{/*
				 * The content column: tab strip on top, then main + ContextBar.
				 *
				 * The strip is scoped to this column rather than spanning the window
				 * because that is the region tabs actually switch - the drawer is a
				 * global navigator and keeps its own header band beside this row.
				 * Its left edge therefore follows the drawer's resize handle for
				 * free: the column is the drawer's flex sibling, so there is no
				 * width to compute or keep in sync.
				 *
				 * `relative` moved down with the strip, onto the main+context row:
				 * the ContextBar's overlay mode (<1200px) positions against its
				 * nearest positioned ancestor, and from the outer row it would now
				 * cover the tabs it belongs to.
				 */}
				<div className="flex flex-1 flex-col min-w-0 overflow-hidden">
					<TabStrip />
					<div className="flex flex-1 overflow-hidden relative">
						<main
							className="flex-1 overflow-hidden flex flex-col min-w-0"
							// A stop in the F6 cycle - see `region-focus.ts`. On `main`
							// rather than on the tabpanel inside it so the cycle reaches
							// the pane whether or not a tab is open.
							data-app-region={"main" satisfies AppRegion}
						>
							{/*
							 * The other half of the strip's tabs pattern: the region a tab
							 * controls has to say so, or `aria-controls` points at nothing
							 * and the panel claims no owner. The role goes on a child of
							 * `main` rather than on `main` itself - `main` is a landmark and
							 * carries only `role="main"`, so overwriting it would trade one
							 * relationship for another.
							 */}
							<div
								role="tabpanel"
								id={activeTab ? tabPanelElementId(activeTab.id) : undefined}
								aria-labelledby={activeTab ? tabElementId(activeTab.id) : undefined}
								className="flex flex-1 flex-col min-w-0 overflow-hidden"
							>
								{/*
								 * One boundary around the panel, not one per surface: only
								 * one surface is mounted at a time, and a boundary inside
								 * each branch would be the same fallback written eight
								 * times. It sits inside the panel div so the tab's aria
								 * relationship holds while its chunk is still loading.
								 */}
								<Suspense
									fallback={
										<DetailSkeleton
											label={LOADING_LABEL[activeTab?.type ?? "welcome"]}
										/>
									}
								>
									{renderTabContent(activeTab)}
								</Suspense>
							</div>
						</main>
						<ContextBar mode={windowWidth >= 1200 ? "push" : "overlay"} />
					</div>
				</div>
			</div>
			<Dock />
		</div>
	);
}
