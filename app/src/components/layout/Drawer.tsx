/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useCallback } from "react";
import { flushSync } from "react-dom";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { useLayoutStore } from "@/stores";
import { cn } from "@/lib/utils";
import { Collapsible } from "@/components/ui";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { regionProps } from "./region-focus";
import { DrawerItemOpenedProvider } from "./drawer-item-opened";
import { focusActiveTab } from "./tab-focus";
import { useOverlayPanel } from "./useOverlayPanel";
import { DEFAULT_DRAWER_WIDTH, type SidePanelMode } from "@/constants/layout";
import CollectionTree from "@/modules/collections/CollectionTree";
import HistoryList from "@/modules/history/sidebar/HistoryList";
import VariablesCategoryTree from "@/modules/variables/sidebar/VariablesCategoryTree";
// The tree's own file, not `@/modules/settings`: that barrel also exports `SettingsMain`, and the
// Drawer is mounted on every tab, so the barrel would pull the settings surface back into the eager
// graph and undo `Shell`'s split (#1146). The sibling trees above are deep imports for the same
// reason.
import SettingsCategoryTree from "@/modules/settings/sidebar/SettingsCategoryTree";
import { ServicesPanel } from "@/modules/services";
import { TrashList } from "@/modules/trash";

interface DrawerProps {
	mode?: SidePanelMode;
	/** The context bar's mode, for the one-overlay-at-a-time rule (`useOverlayPanel`). */
	siblingMode?: SidePanelMode;
}

export function Drawer({ mode = "push", siblingMode = "push" }: DrawerProps) {
	const drawerOpen = useLayoutStore((s) => s.drawerOpen);
	const setDrawerOpen = useLayoutStore((s) => s.setDrawerOpen);
	const drawerView = useLayoutStore((s) => s.drawerView);
	const drawerWidth = useLayoutStore((s) => s.drawerWidth);
	const setDrawerWidth = useLayoutStore((s) => s.setDrawerWidth);
	const panelRef = useOverlayPanel({ panel: "drawer", mode, siblingMode });

	// What the views call once they have opened a tab (`drawer-item-opened.ts`).
	// An overlay has done its job and leaves, with focus on the tab it opened.
	const onItemOpened = useCallback(() => {
		if (mode !== "overlay") return;
		// Commit the tab the caller just opened first: `Shell` reveals the drawer when the active
		// tab's type changes, from an effect this flush runs, and closing before it would be
		// undone.
		flushSync(() => {});
		setDrawerOpen(false);
		focusActiveTab();
	}, [mode, setDrawerOpen]);

	return (
		// `Collapsible`/`CollapsibleContent` with `asChild`, not `collapsible.tsx`'s vertical-only
		// wrapper, for `ContextBar.tsx`'s reason: the same primitive on the other axis.
		<Collapsible asChild open={drawerOpen} onOpenChange={setDrawerOpen}>
			<CollapsiblePrimitive.CollapsibleContent asChild className="rail-collapse">
				{/*
				 * <aside>, so the sidebar is a landmark a screen reader can jump to. Labelled by
				 * the active view: the drawer hosts six panels, and "Complementary" alone would not
				 * say which is showing.
				 *
				 * Overlay mode is the context bar's mirrored: the same shadow and z-index, on the
				 * content's left edge (`Shell` gives the drawer a positioned box of its own).
				 */}
				<aside
					ref={panelRef}
					className={cn(
						"flex shrink-0 bg-panel",
						mode === "overlay"
							? "absolute left-0 top-0 bottom-0 max-w-full shadow-lg z-10"
							: "relative"
					)}
					style={{ width: drawerWidth }}
					aria-label={`${drawerView.charAt(0).toUpperCase()}${drawerView.slice(1)} sidebar`}
					// An F6 stop; `region-focus.ts` says why the bands are marked rather than found
					// by tag name.
					{...regionProps("drawer")}
				>
					<div
						key={drawerView}
						// `.enter-fade` fades the view in on every switch, the key forcing a fresh
						// node per view (the six branches are already different component types, so
						// no extra remount cost). Panel-tier duration: a sidebar page swap is
						// panel-scale, not the small chrome `.enter-fade`'s default menu timing is
						// for.
						className="enter-fade [--enter-fade-duration:var(--dur-panel-in)] panel-clip flex-1 overflow-hidden flex flex-col min-w-0"
					>
						{/*
						 * Each view supplies its own DrawerPanel, which owns the header and the
						 * scroll region, and fetches its own data: data handed down from here loses
						 * its loading state at the boundary, and an in-flight query renders as an
						 * empty tree.
						 */}
						<DrawerItemOpenedProvider value={onItemOpened}>
							{drawerView === "collections" && <CollectionTree />}
							{drawerView === "history" && <HistoryList />}
							{drawerView === "variables" && <VariablesCategoryTree />}
							{drawerView === "services" && <ServicesPanel />}
							{drawerView === "trash" && <TrashList />}
							{drawerView === "settings" && <SettingsCategoryTree />}
						</DrawerItemOpenedProvider>
					</div>

					<PanelResizeHandle
						side="right"
						size={drawerWidth}
						setSize={setDrawerWidth}
						defaultSize={DEFAULT_DRAWER_WIDTH}
						label="Resize sidebar"
					/>
				</aside>
			</CollapsiblePrimitive.CollapsibleContent>
		</Collapsible>
	);
}
