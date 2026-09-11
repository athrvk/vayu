/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { useLayoutStore } from "@/stores";
import { Collapsible } from "@/components/ui";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { regionProps } from "./region-focus";
import { DEFAULT_DRAWER_WIDTH } from "@/constants/layout";
import CollectionTree from "@/modules/collections/CollectionTree";
import HistoryList from "@/modules/history/sidebar/HistoryList";
import VariablesCategoryTree from "@/modules/variables/sidebar/VariablesCategoryTree";
// The tree's own file, not `@/modules/settings`: that barrel also exports
// `SettingsMain`, so importing it here - the Drawer is mounted on every tab -
// would pull the settings surface back into the eager graph and undo the split
// `Shell` makes of it (#1146). The sibling trees above are deep imports for the
// same reason.
import SettingsCategoryTree from "@/modules/settings/sidebar/SettingsCategoryTree";
import { ServicesPanel } from "@/modules/services";
import { TrashList } from "@/modules/trash";

export function Drawer() {
	const { drawerOpen, setDrawerOpen, drawerView, drawerWidth, setDrawerWidth } = useLayoutStore();

	const width = drawerWidth;

	return (
		// See `ContextBar.tsx` for why `Collapsible`/`CollapsibleContent` sit
		// here rather than the vertical-only wrapper in `collapsible.tsx`, and
		// for why both carry `asChild` - same primitive, the other axis, the
		// two sidebars facing each other across the window.
		<Collapsible asChild open={drawerOpen} onOpenChange={setDrawerOpen}>
			<CollapsiblePrimitive.CollapsibleContent asChild className="rail-collapse">
				{/* <aside>, so the sidebar is a landmark a screen reader can jump to
				   instead of an anonymous div. Labelled by the active view because
				   the drawer hosts six different panels - "Complementary" alone
				   would not say which one is showing. */}
				<aside
					className="relative flex shrink-0 bg-panel"
					style={{ width }}
					aria-label={`${drawerView.charAt(0).toUpperCase()}${drawerView.slice(1)} sidebar`}
					// A stop in the F6 cycle - see `region-focus.ts` for why the bands
					// are marked rather than found by tag name.
					{...regionProps("drawer")}
				>
					<div
						key={drawerView}
						// `.enter-fade` fades the view in on every switch - the key
						// forces a fresh node per view (the six branches below are
						// already different component types, so this adds no remount
						// cost beyond what switching views already does). Panel-tier
						// duration: a sidebar page swap is panel-scale, not the
						// small-chrome surface `.enter-fade`'s default menu timing was
						// built for.
						className="enter-fade [--enter-fade-duration:var(--dur-panel-in)] panel-clip flex-1 overflow-hidden flex flex-col min-w-0"
					>
						{/* Each view supplies its own DrawerPanel, which owns the header
						    and the scroll region - the Drawer no longer wraps some views
						    in a ScrollArea and leaves others to manage their own.

						    Views fetch their own data too. The Drawer used to query
						    collections and environments purely to hand them to the
						    Variables view, which meant the loading state was lost at the
						    boundary and an in-flight query rendered as an empty tree. */}
						{drawerView === "collections" && <CollectionTree />}
						{drawerView === "history" && <HistoryList />}
						{drawerView === "variables" && <VariablesCategoryTree />}
						{drawerView === "services" && <ServicesPanel />}
						{drawerView === "trash" && <TrashList />}
						{drawerView === "settings" && <SettingsCategoryTree />}
					</div>

					<PanelResizeHandle
						side="right"
						width={drawerWidth}
						setWidth={setDrawerWidth}
						defaultWidth={DEFAULT_DRAWER_WIDTH}
						label="Resize sidebar"
					/>
				</aside>
			</CollapsiblePrimitive.CollapsibleContent>
		</Collapsible>
	);
}
