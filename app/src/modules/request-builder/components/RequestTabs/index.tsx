/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/** Tab navigation and content panels for request configuration. */

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger, TabLabel, TabCount } from "@/components/ui";
import { cn } from "@/lib/utils";
import { isBlankScriptElement } from "@/lib/elements";
import { TabOverflowMenu } from "@/components/layout/TabOverflowMenu";
import { useFittedTabs } from "@/components/layout/useFittedTabs";
import { MARK_ALLOWANCE } from "@/components/layout/tab-fit";
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
import { displayPathRows, pathRowsOf, queryRowsOf } from "../../utils/path-variables";

/**
 * Tabs whose panel holds Monaco, not a form: Body's code pane and Elements' `script.pre` /
 * `script.post` rows (one editor each, #1643). Force-mounted below (#1718) so a glance at Headers
 * does not rebuild the editor: Radix unmounts an inactive `TabsContent`, and only the text, read
 * back from the store, would survive, losing cursor, scroll and undo. Other tabs keep cheap
 * mount-on-demand; only these carry state a remount destroys.
 */
const EDITOR_TABS = new Set<RequestTab>(["body", "elements"]);

/** `variant="inset"`'s `px-1` per side: inside the fit's wrapper, unusable by the triggers. */
const LIST_PADDING = 8;

/**
 * What a tab's mark may grow to: none without a `badge` key (Examples), a dot for a `presence` tab.
 */
function markAllowanceOf(tab: TabInfo): number {
	if (!("badge" in tab)) return MARK_ALLOWANCE.none;
	return tab.presence ? MARK_ALLOWANCE.dot : MARK_ALLOWANCE.count;
}

/**
 * A tab's trailing mark, shared by its trigger and its "+N" menu item; none without a `badge` key.
 */
function countMarkOf(tab: TabInfo) {
	if (!("badge" in tab)) return null;
	return <TabCount value={tab.badge} presence={tab.presence} />;
}

export default function RequestTabs() {
	const { request, memoryKey, activeTab, setActiveTab } = useRequestBuilderContext();

	/*
	 * Force-mounted from first visit, not from mount: a request opened on Params should not pay for
	 * a Body editor, or a Monaco per `script.*` element, nobody asked for. Once Body or Elements is
	 * seen, its panel stays alive for this builder instance. State, not a ref, since it must
	 * trigger the render that turns `forceMount` on. Seeded from `activeTab`, so a request restored
	 * into Body force-mounts on this render, and updated during render (as `CollectionDetail`'s tab
	 * sync is), not in an effect: a `visited` lagging a render would drop the panel the instant the
	 * user glanced at a sibling.
	 */
	const [visited, setVisited] = useState<ReadonlySet<RequestTab>>(() => new Set([activeTab]));
	if (!visited.has(activeTab)) {
		setVisited((prev) => new Set(prev).add(activeTab));
	}

	const tabs: TabInfo[] = [
		{
			/*
			 * First, deliberately: a description is the first thing to read about a request. Its
			 * badge is a presence dot, not a count: Params and Headers carry real numbers, and a
			 * `1` here read as a count.
			 */
			id: "info",
			label: "Info",
			badge: request.description?.trim() ? 1 : undefined,
			presence: true,
		},
		{
			id: "params",
			label: "Params",
			// Enabled rows of both tables, query and path variables (#1764), as the tab shows them,
			// so a `:name` no stored row answers yet counts: it is the row most likely to need the
			// user.
			badge:
				[
					...queryRowsOf(request.params),
					...displayPathRows(pathRowsOf(request.params), request.url),
				].filter((p) => p.enabled && p.key.trim()).length || undefined,
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
			presence: true,
		},
		{
			id: "auth",
			label: "Auth",
			badge: request.auth.mode !== "none" ? 1 : undefined,
			presence: true,
		},
		{
			id: "elements",
			label: "Elements",
			// A blank script.pre/post is inert (#1609), so it counts no more than a disabled row.
			badge:
				request.elements.filter((e) => e.enabled && !isBlankScriptElement(e)).length ||
				undefined,
		},
		{
			/*
			 * After the elements, before Settings: examples describe what the request answers with,
			 * which belongs by its definition, not among execution options. No badge: the count is
			 * behind a query, and a tab row waiting on the network is worse than one silent until
			 * opened.
			 */
			id: "examples",
			label: "Examples",
		},
		{
			id: "settings",
			label: "Settings",
			// Marked only when the request departs from the engine defaults.
			badge: isRequestSettingsNonDefault(request) ? 1 : undefined,
			presence: true,
		},
	];

	const markAllowances = new Map(tabs.map((t) => [t.id, markAllowanceOf(t)]));
	const { containerRef, visibleIds, overflowedIds } = useFittedTabs({
		ids: tabs.map((t) => t.id),
		labels: tabs.map((t) => t.label),
		activeId: activeTab,
		markAllowance: (id) => markAllowances.get(id) ?? MARK_ALLOWANCE.none,
		reserved: LIST_PADDING,
	});

	return (
		<Tabs
			value={activeTab}
			onValueChange={(v) => setActiveTab(v as RequestTab)}
			className="flex-1 flex flex-col overflow-hidden"
		>
			{/*
			 * The fit measures the wrapper, not the list, which shrinks to what it draws
			 * (`useFittedTabs`); `w-full`, not `flex-1`, since in a column `flex-1` grows height
			 * and leaves width to content. Tabs that do not fit go in the "+N" menu.
			 */}
			<div ref={containerRef} className="flex w-full shrink-0 items-stretch">
				<TabsList variant="inset" className="overflow-hidden flex-nowrap">
					{tabs
						.filter((tab) => visibleIds.includes(tab.id))
						.map((tab) => (
							<TabsTrigger key={tab.id} value={tab.id}>
								<TabLabel>{tab.label}</TabLabel>
								{/*
								 * Unconditional for every tab that *can* carry a count, `undefined`
								 * included: `TabCount` animates its own track open. Gating the
								 * element here made typing the first character into an empty Params
								 * table shove every tab after it sideways. Examples declares no
								 * `badge` key and pays no width, so this asks whether the key is
								 * *there*, not whether its value is set.
								 */}
								{countMarkOf(tab)}
							</TabsTrigger>
						))}
				</TabsList>
				<TabOverflowMenu
					tabs={tabs
						.filter((tab) => overflowedIds.includes(tab.id))
						.map((tab) => ({ id: tab.id, label: tab.label, mark: countMarkOf(tab) }))}
					onSelect={setActiveTab}
				/>
			</div>

			{/*
			 * TabsContent per tab, not a plain <div>: Radix derives each trigger's aria-controls id
			 * from its value, so content outside the Tabs tree left every trigger pointing at a
			 * panel id that did not exist. Each panel renders against `tab.id`, not a component
			 * keyed on `activeTab`, which would blank a force-mounted panel once focus moved,
			 * undoing `forceMount`. `EDITOR_TABS.has(tab.id) && visited.has(tab.id)` force-mounts
			 * Body and Elements from first visit; other tabs mount only while active.
			 * `components/ui/tabs.tsx` hides an inactive force-mounted panel from the accessibility
			 * tree and tab order (`data-[state=inactive]:hidden`), as `CollectionDetail` relies on.
			 *
			 * Mount-on-demand panels are keyed on the builder's `memoryKey` (#3666): one provider
			 * serves every request tab, so a panel's own state (a bulk-edit draft, a revealed
			 * secret, a key being typed) would follow the user into the next request. Body and
			 * Elements cannot be keyed (a remount rebuilds Monaco), so Body resets its own state.
			 */}
			{tabs.map((tab) => (
				<TabsContent
					key={tab.id}
					value={tab.id}
					forceMount={EDITOR_TABS.has(tab.id) && visited.has(tab.id) ? true : undefined}
					className={cn(
						"mt-0 flex-1 overflow-y-auto p-4",
						// Only Body is one editor filling the pane, so only it gets the flex
						// column; Elements lays out its rows in its own scrollable block.
						tab.id === "body" && "flex flex-col"
					)}
				>
					{tab.id === "info" && <InfoPanel key={memoryKey} />}
					{tab.id === "params" && <ParamsPanel key={memoryKey} />}
					{tab.id === "headers" && <HeadersPanel key={memoryKey} />}
					{tab.id === "body" && <BodyPanel />}
					{tab.id === "auth" && <AuthPanel key={memoryKey} />}
					{tab.id === "elements" && <ElementsPanel />}
					{tab.id === "examples" && <ExamplesPanel key={memoryKey} />}
					{tab.id === "settings" && <SettingsPanel key={memoryKey} />}
				</TabsContent>
			))}
		</Tabs>
	);
}
