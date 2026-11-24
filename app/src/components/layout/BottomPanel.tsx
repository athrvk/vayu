/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The shell's bottom band (#3635): a full-width panel between the main row and the Dock, under the
 * sidebar and the content alike, with tabs for the session Console (#3634) and Logs.
 *
 * Not a second `Drawer`: the Drawer is the left sidebar, and "drawer" is an identifier a user never
 * reads (`docs/ux-writing.md`). The Dock, the palette and the region label name the panel for what
 * it holds, `BOTTOM_PANEL_LABEL`.
 *
 * Open state, height and the active tab live in `layout-store`. The panel renders nothing while
 * closed, so a tab's content is mounted only while on screen, the lifecycle a tail or a poll wants.
 * The height drawn is the stored choice held to half the window (`clampBottomPanelHeight`), so a
 * window shrunk below the choice shows a smaller panel without forgetting it.
 *
 * The top edge is its `PanelResizeHandle` (`side: "top"`), which also draws the rule between the
 * panel and the main row. The tab strip is ordinary `pane` chrome on `bg-panel`, the root surface,
 * where `border-rule` falls back to the right colour; a surface inside a tab declares its own
 * (`BottomPanel.surface-rule.test.tsx`).
 */

import type { ComponentType } from "react";
import { useLayoutStore } from "@/stores";
import {
	BOTTOM_PANEL_LABEL,
	BOTTOM_PANEL_MIN_HEIGHT,
	BOTTOM_PANEL_TABS,
	DEFAULT_BOTTOM_PANEL_HEIGHT,
	bottomPanelMaxHeight,
	clampBottomPanelHeight,
	resolveBottomPanelTab,
	type BottomPanelTab,
} from "@/constants/layout";
import { useWindowHeight } from "@/hooks/useWindowWidth";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui";
import { ConsoleTab } from "@/modules/console";
import { LogsTab } from "@/modules/logs";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { regionProps } from "./region-focus";

/** What each tab shows. A `Record`, so a tab with no body is a compile error. */
const TAB_BODIES: Record<BottomPanelTab, ComponentType> = {
	console: ConsoleTab,
	logs: LogsTab,
};

export function BottomPanel() {
	const open = useLayoutStore((s) => s.bottomPanelOpen);
	const height = useLayoutStore((s) => s.bottomPanelHeight);
	const storedTab = useLayoutStore((s) => s.bottomPanelTab);
	const setHeight = useLayoutStore((s) => s.setBottomPanelHeight);
	const setTab = useLayoutStore((s) => s.setBottomPanelTab);
	const windowHeight = useWindowHeight();

	if (!open) return null;

	const shownHeight = clampBottomPanelHeight(height, windowHeight);

	return (
		<section
			aria-label={BOTTOM_PANEL_LABEL}
			className="relative flex shrink-0 flex-col bg-panel"
			style={{ height: shownHeight }}
			// A stop in the F6 cycle - see `region-focus.ts`.
			{...regionProps("bottom-panel")}
		>
			<PanelResizeHandle
				side="top"
				size={shownHeight}
				setSize={setHeight}
				defaultSize={DEFAULT_BOTTOM_PANEL_HEIGHT}
				label={`Resize ${BOTTOM_PANEL_LABEL.toLowerCase()}`}
				min={BOTTOM_PANEL_MIN_HEIGHT}
				max={bottomPanelMaxHeight(windowHeight)}
			/>
			<Tabs
				value={resolveBottomPanelTab(storedTab)}
				onValueChange={(id) => setTab(resolveBottomPanelTab(id))}
				className="flex min-h-0 flex-1 flex-col"
			>
				<TabsList variant="pane" size="sm" aria-label="Panel tabs">
					{BOTTOM_PANEL_TABS.map((tab) => (
						<TabsTrigger key={tab.id} value={tab.id}>
							{tab.label}
						</TabsTrigger>
					))}
				</TabsList>
				{BOTTOM_PANEL_TABS.map((tab) => {
					const Body = TAB_BODIES[tab.id];
					return (
						<TabsContent
							key={tab.id}
							value={tab.id}
							className="flex min-h-0 flex-1 flex-col overflow-hidden"
						>
							<Body />
						</TabsContent>
					);
				})}
			</Tabs>
		</section>
	);
}
