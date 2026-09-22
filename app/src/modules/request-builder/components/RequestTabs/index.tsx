/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RequestTabs Component
 *
 * Tab navigation and content panels for request configuration
 */

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger, TabLabel, TabCount } from "@/components/ui";
import { cn } from "@/lib/utils";
import { isBlankScriptElement } from "@/lib/elements";
import { useRequestBuilderContext } from "../../context";
import type { RequestTab, TabInfo } from "../../types";
import InfoPanel from "./panels/InfoPanel";
import ParamsPanel from "./panels/ParamsPanel";
import HeadersPanel from "./panels/HeadersPanel";
import BodyPanel from "./panels/BodyPanel";
import AuthPanel from "./panels/AuthPanel";
import ElementsPanel from "./panels/ElementsPanel";
import ExamplesPanel from "./panels/ExamplesPanel";
import SettingsPanel from "./panels/SettingsPanel";
import { isRequestSettingsNonDefault } from "../../utils/request-state";

/**
 * The tabs whose panel carries a Monaco editor rather than a form: Body's code
 * pane, and Elements' `script.pre` / `script.post` rows (one editor each,
 * issue #1643 gave every row its own height).
 *
 * Force-mounted below (issue #1718) so switching to Headers and back does not
 * tear the editor down and rebuild it - cursor, scroll position and undo
 * history used to reset on every glance elsewhere, because Radix unmounts an
 * inactive `TabsContent` and the text is all that survives, read back from the
 * request store. Params, Headers, Auth and the rest keep their cheap
 * mount-on-demand behaviour; only these two carry state a remount destroys.
 */
const EDITOR_TABS = new Set<RequestTab>(["body", "elements"]);

export default function RequestTabs() {
	const { request, activeTab, setActiveTab } = useRequestBuilderContext();

	/*
	 * Force-mounted from first visit onward, not from mount: a request opened
	 * on Params should not pay for a Body editor - or, worse, one Monaco
	 * instance per `script.pre`/`script.post` element - that nobody asked for.
	 * Once the user has looked at Body or Elements, the panel (and everything
	 * it mounted) stays alive for the rest of this builder instance; component
	 * state rather than a ref because it has to trigger the re-render that
	 * turns `forceMount` on.
	 *
	 * Seeded from the incoming `activeTab` so a request restored straight into
	 * Body force-mounts on this very render, not a frame late - and updated by
	 * comparing against the last-seen tab during render (the same
	 * derived-during-render shape `CollectionDetail`'s per-collection tab sync
	 * uses) rather than in an effect, since the active tab already renders
	 * regardless of `forceMount` and a `visited` that lagged a render would
	 * only matter for the one thing this exists to prevent: dropping it the
	 * instant the user glanced at a sibling tab.
	 */
	const [visited, setVisited] = useState<ReadonlySet<RequestTab>>(() => new Set([activeTab]));
	if (!visited.has(activeTab)) {
		setVisited((prev) => new Set(prev).add(activeTab));
	}

	// Calculate badges for tabs
	const tabs: TabInfo[] = [
		{
			/*
			 * First, deliberately. A description is the first thing you want to
			 * read about a request and the last thing you find at the end of a
			 * tab row. The badge is `1` for "there is something here" rather than
			 * a count, which is exactly what Body, Auth, Pre-request, Tests and
			 * Settings already do - so it needs no new primitive.
			 */
			id: "info",
			label: "Info",
			badge: request.description?.trim() ? 1 : undefined,
		},
		{
			id: "params",
			label: "Params",
			badge: request.params.filter((p) => p.enabled && p.key.trim()).length || undefined,
		},
		{
			id: "headers",
			label: "Headers",
			badge: request.headers.filter((h) => h.enabled && h.key.trim()).length || undefined,
		},
		{
			id: "body",
			label: "Body",
			badge: request.bodyMode !== "none" ? 1 : undefined,
		},
		{
			id: "auth",
			label: "Auth",
			badge: request.auth.mode !== "none" ? 1 : undefined,
		},
		{
			id: "elements",
			label: "Elements",
			// A blank script.pre/post is inert (#1609) - it does nothing, so it
			// doesn't count toward "something is here" any more than a disabled row.
			badge:
				request.elements.filter((e) => e.enabled && !isBlankScriptElement(e)).length ||
				undefined,
		},
		{
			/*
			 * After the elements and before Settings: examples describe what the
			 * request answers with, which belongs beside the request's own
			 * definition rather than among its execution options. No badge - the
			 * count lives behind a query, and a tab row that waits on the network
			 * to finish drawing is worse than one that says nothing until opened.
			 */
			id: "examples",
			label: "Examples",
		},
		{
			id: "settings",
			label: "Settings",
			// Badges only when the request departs from the engine defaults, so
			// the tab stays quiet for the requests that never touch it.
			badge: isRequestSettingsNonDefault(request) ? 1 : undefined,
		},
	];

	return (
		<Tabs
			value={activeTab}
			onValueChange={(v) => setActiveTab(v as RequestTab)}
			className="flex-1 flex flex-col overflow-hidden"
		>
			{/* Tab Headers */}
			<TabsList
				variant="inset"
				className="w-full overflow-x-auto overflow-y-hidden flex-nowrap scrollbar-strip"
			>
				{tabs.map((tab) => (
					<TabsTrigger key={tab.id} value={tab.id}>
						<TabLabel>{tab.label}</TabLabel>
						{/*
						 * Unconditional for every tab that *can* carry a count,
						 * `undefined` and all - `TabCount` animates its own track
						 * open rather than reserving one. Gating the element here is
						 * exactly what made typing the first character into an empty
						 * Params table shove the seven tabs after Params, and the
						 * `Table` toggle sharing their row, sideways. Examples can
						 * never carry a count, so it declares no `badge` key at all
						 * and pays no width at all, ever - which is why this asks
						 * whether the key is *there*, not whether its value is set.
						 */}
						{"badge" in tab && <TabCount value={tab.badge} />}
					</TabsTrigger>
				))}
			</TabsList>

			{/*
			 * TabsContent per tab, not a plain <div>. Radix derives an
			 * aria-controls id per trigger from its value, so rendering the
			 * content outside the Tabs tree left all six triggers pointing at
			 * panel ids that never existed - a tablist with no reachable panels.
			 *
			 * Each panel renders inline against `tab.id` rather than through a
			 * separate component keyed on `activeTab`: a switch on the *active*
			 * tab would render nothing for a force-mounted panel the moment focus
			 * moved elsewhere, undoing the one thing `forceMount` exists to do.
			 * `EDITOR_TABS.has(tab.id) && visited.has(tab.id)` force-mounts Body
			 * and Elements from their first visit onward; every other tab keeps
			 * Radix's default of mounting only while active, so `TabsContent`
			 * still renders exactly one panel until a second one has actually
			 * been visited. `components/ui/tabs.tsx` hides an inactive
			 * force-mounted panel from the accessibility tree and the tab order
			 * (`data-[state=inactive]:hidden`), the same way `CollectionDetail`
			 * relies on it for its own force-mounted drafts.
			 */}
			{tabs.map((tab) => (
				<TabsContent
					key={tab.id}
					value={tab.id}
					forceMount={EDITOR_TABS.has(tab.id) && visited.has(tab.id) ? true : undefined}
					className={cn(
						"mt-0 flex-1 overflow-y-auto p-4",
						// Only Body's panel is one editor filling the whole pane - the
						// flex column that lets it do so is not tied to force-mount
						// membership. Elements is a list of rows with an editor apiece,
						// laid out by its own scrollable block.
						tab.id === "body" && "flex flex-col"
					)}
				>
					{tab.id === "info" && <InfoPanel />}
					{tab.id === "params" && <ParamsPanel />}
					{tab.id === "headers" && <HeadersPanel />}
					{tab.id === "body" && <BodyPanel />}
					{tab.id === "auth" && <AuthPanel />}
					{tab.id === "elements" && <ElementsPanel />}
					{tab.id === "examples" && <ExamplesPanel />}
					{tab.id === "settings" && <SettingsPanel />}
				</TabsContent>
			))}
		</Tabs>
	);
}
