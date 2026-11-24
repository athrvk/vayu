/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { lazy, Suspense, useEffect } from "react";
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
	TOGGLE_BOTTOM_PANEL_CHORD,
	TOGGLE_RESPONSE_POSITION_CHORD,
	SETTINGS_CHORD,
	NEW_REQUEST_CHORD,
	FOCUS_URL_CHORD,
	NEXT_TAB_CHORD,
	PREVIOUS_TAB_CHORD,
	NEXT_REGION_CHORD,
	PREVIOUS_REGION_CHORD,
	GO_BACK_CHORD,
	GO_FORWARD_CHORD,
	DRAWER_VIEW_CHORDS,
	TAB_CHORDS,
	matchesChord,
} from "@/constants/shortcuts";
import { ownsEnterKey } from "@/lib/keyboard";
import { navigateHistory, type NavDirection } from "@/lib/navigate-history";
import { useNewRequest } from "@/hooks/useNewRequest";
import { useWindowWidth } from "@/hooks/useWindowWidth";
import {
	CONTEXT_BAR_PUSH_MIN_WIDTH,
	DRAWER_PUSH_MIN_WIDTH,
	sidePanelMode,
} from "@/constants/layout";
import { ImportModal } from "@/modules/collections/ImportModal";
import { CollectionPicker } from "@/modules/welcome/components/CollectionPicker";
import { Drawer } from "./Drawer";
import { BottomPanel } from "./BottomPanel";
import { Dock } from "./Dock";
import { ActivityRail } from "./ActivityRail";
import { ContextBar } from "./ContextBar";
import { ContextRail } from "./ContextRail";
import { RunAnnouncer } from "./RunAnnouncer";
import { TabStrip } from "./TabStrip";
import { tabElementId, tabPanelElementId } from "./tab-aria";
import { closeTabFromKeyboard } from "./tab-focus";
import { cycleRegionFocus, focusRequestUrl, regionProps } from "./region-focus";
import { CommandPalette } from "@/modules/palette";
import { DetailSkeleton } from "@/components/shared/DetailSkeleton";
import { HeadingSection } from "@/components/ui/heading";
import RequestBuilder from "@/modules/request-builder";

/*
 * One tab's surface is mounted at a time, so each is its own chunk, fetched when its tab is first
 * opened: eager, the surfaces not on screen were 5.5MB of module graph parsed before the window
 * could appear (#1146). RequestBuilder stays eager: anyone with a request tab restored opens into
 * it, so deferring it would trade paint time for a skeleton on the surface most likely to be first.
 */
const CollectionDetail = lazy(() => import("@/modules/collections/CollectionDetail"));
const LoadTestDashboard = lazy(() => import("@/modules/dashboard"));
/*
 * A surface splits only when it is imported from the component's own file, not its module barrel: a
 * barrel is one module, so one eager import of it anywhere (`Drawer`, mounted on every tab, reads
 * `SettingsCategoryTree` from the settings module) would pull the surface back in.
 */
const HistoryDetail = lazy(() => import("@/modules/history/main/HistoryDetail"));
const WelcomeScreen = lazy(() => import("@/modules/welcome/WelcomeScreen"));
const SettingsMain = lazy(() => import("@/modules/settings/main/SettingsMain"));
const VariablesMain = lazy(() => import("@/modules/variables/main/VariablesMain"));
const InboxView = lazy(() => import("@/modules/inbox"));
const MockServerView = lazy(() => import("@/modules/mock-server"));

/**
 * What the skeleton says while a surface's chunk loads, per tab type rather than a bare "Loading":
 * which pane is arriving is the one thing the placeholder knows and a screen reader cannot see.
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
	"mock-server": "Loading mock server",
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
		case "mock-server":
			return <MockServerView />;
		default:
			return null;
	}
}

/**
 * Which way this key cycles the window's regions, or `null` for neither region chord. Outside the
 * component and asked before the handler's modifier gate: F6 is the one chord in the map with no ⌘
 * or Ctrl.
 */
function regionStep(e: KeyboardEvent): 1 | -1 | null {
	if (matchesChord(e, NEXT_REGION_CHORD)) return 1;
	if (matchesChord(e, PREVIOUS_REGION_CHORD)) return -1;
	return null;
}

/**
 * Which way this key navigates the history, or `null` for neither chord. Asked before the modifier
 * gate like F6: off macOS the pair is Alt+←/→, with no ⌘ or Ctrl (#1245).
 *
 * A code editor keeps the chord, the one place either pair means something else: Monaco binds
 * CtrlCmd+[ and +] to outdent and indent, so on macOS, where that pair is the chord, navigating
 * would break editing. `ownsEnterKey`, not `isTextEntryTarget`, so a plain input does not keep it:
 * Back from the URL bar is what a browser does, and neither ⌘[ nor Alt+← edits text in a field. The
 * collection tree's Alt+Arrow reorder and the tab strip's Alt+Arrow move need no check here: each
 * handler stops the event at its own widget.
 */
function navigationStep(e: KeyboardEvent): NavDirection | null {
	if (e.target instanceof HTMLElement && ownsEnterKey(e.target)) return null;
	if (matchesChord(e, GO_BACK_CHORD)) return "back";
	if (matchesChord(e, GO_FORWARD_CHORD)) return "forward";
	return null;
}

/**
 * Which way this pointer button navigates, or `null` for an ordinary button. Chromium reports the
 * mouse's thumb buttons as 3 and 4 on every platform, the only route to them in the renderer: they
 * produce no key event and no click on the element under the pointer.
 */
function pointerNavigationStep(button: number): NavDirection | null {
	if (button === 3) return "back";
	if (button === 4) return "forward";
	return null;
}

export default function Shell() {
	const openTabs = useTabsStore((s) => s.openTabs);
	const activeTabId = useTabsStore((s) => s.activeTabId);
	const focusTab = useTabsStore((s) => s.focusTab);
	const focusAdjacentTab = useTabsStore((s) => s.focusAdjacentTab);
	const openTab = useTabsStore((s) => s.openTab);
	/*
	 * The Shell hosts the new-request flow for its ⌘N chord and the palette its own for "New
	 * request": two hosts of one hook, not two flows. `useNewRequest` is built to mount more than
	 * once (each caller renders its own picker from `pickerProps`, so two surfaces never fight over
	 * one dialog's open state), and both reach the same creation path.
	 */
	const { newRequest, pickerProps } = useNewRequest();
	const toggleDrawer = useLayoutStore((s) => s.toggleDrawer);
	const activateDrawerView = useLayoutStore((s) => s.activateDrawerView);
	const toggleContextBar = useLayoutStore((s) => s.toggleContextBar);
	const toggleBottomPanel = useLayoutStore((s) => s.toggleBottomPanel);
	const toggleResponsePosition = useLayoutStore((s) => s.toggleResponsePosition);
	const revealDrawerView = useLayoutStore((s) => s.revealDrawerView);
	const triggerSave = useSaveStore((s) => s.triggerSave);
	const windowWidth = useWindowWidth();
	const drawerMode = sidePanelMode(windowWidth, DRAWER_PUSH_MIN_WIDTH);
	const contextBarMode = sidePanelMode(windowWidth, CONTEXT_BAR_PUSH_MIN_WIDTH);

	const activeTab = openTabs.find((t) => t.id === activeTabId) ?? null;

	// Auto-open the matching drawer view when navigating to a tab whose entity
	// lives in a drawer (collections tree for requests/collections, variables list).
	useEffect(() => {
		if (activeTab?.type === "variables") {
			revealDrawerView("variables");
		} else if (activeTab?.type === "settings") {
			revealDrawerView("settings");
		} else if (activeTab?.type === "collection" || activeTab?.type === "request") {
			revealDrawerView("collections");
		} else if (activeTab?.type === "run") {
			/*
			 * A run's list is History, so a run tab belongs with it, with the drawer open. Opening
			 * a run must not throw the user out of the History list, and revealing History is what
			 * keeps them in it.
			 */
			revealDrawerView("history");
		} else if (activeTab?.type === "dashboard") {
			/*
			 * Deliberately nothing, written out rather than left to fall off the end: a missing
			 * branch reads the same as one nobody considered (how the `run` case was a bug), and
			 * invites one added for completeness.
			 *
			 * The dashboard is a detour from a request, not a list item: only the request builder
			 * opens it, when a load test starts, with `entityId: null`, and its back button returns
			 * to `sourceRequestId` rather than closing. The drawer is already on Collections with
			 * that request revealed, where the user came from and where Back sends them; switching
			 * to History would discard that context twice per round trip. A judgement call: a
			 * running test does appear in History (`listRuns` applies no status filter, and the
			 * sidebar offers a "Running" filter), so History would be contrary to the flow, not
			 * nonsensical.
			 */
		}
	}, [activeTab?.type, revealDrawerView]);

	useEffect(() => {
		/*
		 * Every chord here is a definition in `constants/shortcuts.ts`, matched by `matchesChord`:
		 * the registry the ActivityRail's tooltips advertise from and the matcher the Send/Load
		 * Test handler uses (#938). A hand-rolled comparison against `e.key` misses what the
		 * registry compares: `altKey` (Ctrl+Alt+S is AltGr+S on many European Windows layouts, and
		 * must not save) and the digit row independent of layout (⌘1-9 on AZERTY, whose unshifted
		 * digits produce `&é"'(-è_çà`).
		 */
		const handleKeyDown = (e: KeyboardEvent) => {
			// F6 and ⇧F6, the only chords here without the primary modifier, are settled before the
			// gate that lets every other key go by untouched, which keeps this listener off the
			// typing path.
			const region = regionStep(e);
			const navigation = navigationStep(e);
			if (region === null && navigation === null && !(e.metaKey || e.ctrlKey)) return;
			/*
			 * Nothing here acts while a modal is up (#935): every chord below moves or destroys
			 * what the dialog is attached to (⌘W closes the tab under it, ⌘1-9 switches away from
			 * it), so the dialog's owner would unmount mid-interaction and the dialog with it.
			 * Escape closes the dialog first; then the chords are live again. ⌘K is not in this
			 * map: `CommandPalette` binds it and asks `isModalOpen()` itself, so it too refuses to
			 * open over another dialog. Its toggle-closed still works with the palette up, as that
			 * guard applies only while the palette is closed.
			 */
			if (isModalOpen()) return;

			if (region !== null) {
				e.preventDefault();
				cycleRegionFocus(region);
				return;
			}
			if (navigation !== null) {
				e.preventDefault();
				navigateHistory(navigation, "chord");
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
			if (matchesChord(e, TOGGLE_BOTTOM_PANEL_CHORD)) {
				e.preventDefault();
				toggleBottomPanel();
				return;
			}
			if (matchesChord(e, TOGGLE_RESPONSE_POSITION_CHORD)) {
				e.preventDefault();
				// Only a request tab has a response pane to move; the Dock's
				// button and the palette row are gated the same way (#1711).
				if (activeTab?.type === "request") toggleResponsePosition();
				return;
			}
			if (matchesChord(e, SETTINGS_CHORD)) {
				e.preventDefault();
				openTab({ type: "settings", entityId: null });
				return;
			}

			// The drawer switchers, from the table the ActivityRail's tooltips read. Settings is in
			// it too and is handled above, by the chord it shares: opening the tab brings its
			// drawer view with it.
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
		toggleBottomPanel,
		toggleResponsePosition,
		activateDrawerView,
		openTab,
		focusTab,
		focusAdjacentTab,
		newRequest,
		activeTabId,
		activeTab,
		openTabs,
	]);

	useEffect(() => {
		/*
		 * The mouse's own back and forward buttons (#1245). On `mouseup`, what a button press means
		 * everywhere else, and on `window`, not a container: these buttons are aimed at the app,
		 * not at whatever the pointer is over. `preventDefault`: Chromium's own default navigates
		 * the *document*, which in a packaged app leaves the app's page for whatever it was loaded
		 * from. `isModalOpen` as in the chord map (#935): a dialog is portalled into
		 * `document.body` and stops nothing, so a press on it bubbles here, and navigating unmounts
		 * the surface the dialog belongs to.
		 */
		const handleMouseUp = (e: MouseEvent) => {
			const direction = pointerNavigationStep(e.button);
			if (direction === null) return;
			if (isModalOpen()) return;
			e.preventDefault();
			navigateHistory(direction, "pointer");
		};
		window.addEventListener("mouseup", handleMouseUp);
		return () => window.removeEventListener("mouseup", handleMouseUp);
	}, []);

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
			{/* Here rather than in a run view: a run ends while its tab is not the
			    one mounted, and the region must outlive every tab. */}
			<RunAnnouncer />
			{/* Every tab uses the same shell: the ActivityRail's view switchers,
			    one left Drawer (its view switches with the tab -
			    collections/history/variables/settings), the main content, and the
			    request-only ContextBar with its own ContextRail. No tab type takes
			    over the row, so the rail always has a Drawer to act on. */}
			<div className="flex flex-1 overflow-hidden">
				<ActivityRail />
				{/*
				 * The drawer's positioned box: the drawer and the content column, not the
				 * ActivityRail. In overlay mode the drawer is `absolute left-0` against it, so it
				 * opens over the content's left edge, never over the rail that toggles it (#3494).
				 * The box is there in both modes, so crossing the threshold changes a class list,
				 * never the tree the active tab renders into.
				 */}
				<div className="relative flex flex-1 min-w-0 overflow-hidden">
					<Drawer mode={drawerMode} siblingMode={contextBarMode} />
					{/*
					 * The content column: tab strip on top, then main + ContextBar. The strip spans
					 * this column, not the window, as this is the region tabs switch; the drawer is
					 * a global navigator with its own header band beside this row. As the drawer's
					 * flex sibling, the column's left edge follows the drawer's resize handle in
					 * push mode with no width to keep in sync.
					 *
					 * `relative` is on the main+context row, below the strip: the ContextBar's
					 * overlay mode positions against its nearest positioned ancestor, and from the
					 * outer row it would cover the tabs. `ContextRail` sits one level out from that
					 * box, a plain flex item beside it, so an overlaying ContextBar covers `main`
					 * up to the rail and never the rail, which keeps the rail reachable in overlay
					 * mode (#1615).
					 */}
					<div className="flex flex-1 flex-col min-w-0 overflow-hidden">
						<TabStrip />
						<div className="flex flex-1 overflow-hidden">
							<div className="flex flex-1 overflow-hidden relative">
								<main
									className="flex-1 overflow-hidden flex flex-col min-w-0"
									// A stop in the F6 cycle - see `region-focus.ts`. On `main`
									// rather than on the tabpanel inside it so the cycle reaches
									// the pane whether or not a tab is open.
									{...regionProps("main")}
								>
									{/*
									 * The other half of the strip's tabs pattern: the region a tab
									 * controls says so, or `aria-controls` points at nothing and
									 * the panel claims no owner. The role goes on a child of
									 * `main`: `main` is a landmark carrying only `role="main"`, and
									 * overwriting it would trade one relationship for another.
									 */}
									<div
										role="tabpanel"
										id={activeTab ? tabPanelElementId(activeTab.id) : undefined}
										aria-labelledby={
											activeTab ? tabElementId(activeTab.id) : undefined
										}
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
													label={
														LOADING_LABEL[activeTab?.type ?? "welcome"]
													}
												/>
											}
										>
											{/* The outline opens here, so a tab's own title is its
											    `h1` and every heading below it is levelled from that
											    one (`heading-level.tsx`, #3498). */}
											<HeadingSection level={1}>
												{renderTabContent(activeTab)}
											</HeadingSection>
										</Suspense>
									</div>
								</main>
								<ContextBar mode={contextBarMode} siblingMode={drawerMode} />
							</div>
							<ContextRail />
						</div>
					</div>
				</div>
			</div>
			{/* Under the whole main row, sidebar and content alike, so no tab type
			    takes it over; closed, it renders nothing. */}
			<BottomPanel />
			<Dock />
		</div>
	);
}
