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

/**
 * `variant="inset"`'s `px-1` on both sides of the list, which the fit's wrapper
 * contains but the triggers cannot use.
 */
const LIST_PADDING = 8;

/**
 * What a tab's mark may grow to once it arrives. A tab with no `badge` key can
 * never carry one (Examples), and a `presence` tab draws a dot, not digits.
 */
function markAllowanceOf(tab: TabInfo): number {
	if (!("badge" in tab)) return MARK_ALLOWANCE.none;
	return tab.presence ? MARK_ALLOWANCE.dot : MARK_ALLOWANCE.count;
}

/**
 * A tab's trailing mark, shared by its trigger and its "+N" menu item. A tab
 * with no `badge` key can never carry one (Examples).
 */
function countMarkOf(tab: TabInfo) {
	if (!("badge" in tab)) return null;
	return <TabCount value={tab.badge} presence={tab.presence} />;
}

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
			 * tab row. Its badge is a presence dot, not a count: Params and
			 * Headers carry real numbers, and a `1` here read as one of something.
			 */
			id: "info",
			label: "Info",
			badge: request.description?.trim() ? 1 : undefined,
			presence: true,
		},
		{
			id: "params",
			label: "Params",
			// Both tables' enabled rows: the query's and the path variables'
			// (#1764), as the tab shows them - so a `:name` no stored row answers
			// yet counts too; it is the row most likely to need the user.
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
			// Marked only when the request departs from the engine defaults, so
			// the tab stays quiet for the requests that never touch it.
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
			 * Tab Headers. The fit measures the wrapper, not the list, which shrinks
			 * to what it draws (`useFittedTabs`); `w-full` rather than `flex-1`
			 * because the wrapper sits in a column, where `flex-1` would grow it
			 * vertically and leave its width to its content. Tabs that do not fit are
			 * in the "+N" menu rather than scrolled out of sight.
			 */}
			<div ref={containerRef} className="flex w-full shrink-0 items-stretch">
				<TabsList variant="inset" className="overflow-hidden flex-nowrap">
					{tabs
						.filter((tab) => visibleIds.includes(tab.id))
						.map((tab) => (
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
