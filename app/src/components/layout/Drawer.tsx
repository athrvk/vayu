/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useLayoutStore } from "@/stores";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { DEFAULT_DRAWER_WIDTH } from "@/constants/layout";
import CollectionTree from "@/modules/collections/CollectionTree";
import HistoryList from "@/modules/history/sidebar/HistoryList";
import VariablesCategoryTree from "@/modules/variables/sidebar/VariablesCategoryTree";
import { SettingsCategoryTree } from "@/modules/settings";

export function Drawer() {
	const { drawerOpen, drawerView, drawerWidth, setDrawerWidth } = useLayoutStore();

	if (!drawerOpen) return null;

	const width = drawerWidth;

	return (
		/* <aside>, so the sidebar is a landmark a screen reader can jump to
		   instead of an anonymous div. Labelled by the active view because the
		   drawer hosts four different panels — "Complementary" alone would not
		   say which one is showing. */
		<aside
			className="relative flex shrink-0 bg-panel"
			style={{ width }}
			aria-label={`${drawerView.charAt(0).toUpperCase()}${drawerView.slice(1)} sidebar`}
		>
			<div className="panel-clip flex-1 overflow-hidden flex flex-col min-w-0">
				{/* Each view supplies its own DrawerPanel, which owns the header and
				    the scroll region — the Drawer no longer wraps some views in a
				    ScrollArea and leaves others to manage their own.

				    Views fetch their own data too. The Drawer used to query
				    collections and environments purely to hand them to the
				    Variables view, which meant the loading state was lost at the
				    boundary and an in-flight query rendered as an empty tree. */}
				{drawerView === "collections" && <CollectionTree />}
				{drawerView === "history" && <HistoryList />}
				{drawerView === "variables" && <VariablesCategoryTree />}
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
	);
}
