/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useLayoutStore } from "@/stores";
import { DEFAULT_DRAWER_WIDTHS } from "@/constants/layout";
import { useCollectionsQuery, useEnvironmentsQuery } from "@/queries";
import { ScrollArea } from "@/components/ui";
import CollectionTree from "@/modules/collections/CollectionTree";
import HistoryList from "@/modules/history/sidebar/HistoryList";
import VariablesCategoryTree from "@/modules/variables/sidebar/VariablesCategoryTree";

export function Drawer() {
	const { drawerOpen, drawerView, drawerWidths, setDrawerWidth } = useLayoutStore();
	const { data: collections = [] } = useCollectionsQuery();
	const { data: environments = [] } = useEnvironmentsQuery();

	if (!drawerOpen) return null;

	const width = drawerWidths[drawerView];

	const startResize = (e: React.PointerEvent) => {
		e.currentTarget.setPointerCapture(e.pointerId);
		const startX = e.clientX;
		const startWidth = drawerWidths[drawerView];

		const onMove = (moveEvent: PointerEvent) => {
			setDrawerWidth(drawerView, startWidth + moveEvent.clientX - startX);
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};

	return (
		<div className="relative flex shrink-0 bg-panel" style={{ width }}>
			<div className="flex-1 overflow-hidden flex flex-col min-w-0">
				{drawerView === "collections" && <CollectionTree />}
				{drawerView === "history" && <HistoryList />}
				{drawerView === "variables" && (
					<ScrollArea className="h-full w-full">
						<VariablesCategoryTree
							collections={collections}
							environments={environments}
						/>
					</ScrollArea>
				)}
			</div>

			<div
				className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize hover:bg-accent/20"
				onPointerDown={startResize}
				onDoubleClick={() => setDrawerWidth(drawerView, DEFAULT_DRAWER_WIDTHS[drawerView])}
			>
				<div className="absolute right-0 top-0 bottom-0 w-px bg-border" />
			</div>
		</div>
	);
}
